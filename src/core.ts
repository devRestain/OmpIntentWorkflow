import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Adoption, Check, Evidence, Plan, PlanInput, Requirement, Result, RunState, SessionInfo, SteeringChange, Task, UserEvent, Workspace, InputAttachment, ReviewCorrection } from './contracts';

type Stored = { state: RunState; evidence: Evidence[]; adoptionRevisions: Record<string, number>; adoptionRefs: Record<string, string>; paused: boolean; cancelled: boolean; planningEpoch?: number; displayCursor?: number; previousDisplay?: {digest:string;cursor:number}; progressSignatures?: Record<string, number> };
type SnapshotRow = { payload: string; sequence: number; hash: string };
const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = <T>(values: T[]) => [...new Set(values)];
const equalSet = (a: number[], b: number[]) => a.length === b.length && a.every(value => b.includes(value));
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function sameVersions(a: Record<string, number>, b: Record<string, number>) { return digest(Object.entries(a).sort()) === digest(Object.entries(b).sort()); }
function planDigest(plan: PlanInput, revision: number, sources: number[]) { return digest({ ...plan, revision, sourceEventIds: sources }); }

/** Canonical state is owned by one live process; every mutation and its receipt commit together. */
export class Engine {
  private readonly db: Database;
  private readonly token = randomUUID();
  private stored!: Stored;
  private sequence = 0;
  private hash = '';
  private closed = false;
  private reconciled = false;

  constructor(dbPath: string, repo: string, runId?: string) {
    requireThat(dbPath !== ':memory:', 'Durable workflow requires an on-disk database');
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      const integrity = this.db.query('PRAGMA integrity_check').all() as Record<string, unknown>[];
      requireThat(integrity.length === 1 && Object.values(integrity[0]!)[0] === 'ok', 'Workflow database integrity check failed');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, repo TEXT NOT NULL, payload TEXT NOT NULL, sequence INTEGER NOT NULL, hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(run_id, sequence));
        CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT, 'History is append-only'); END;
      `);
      this.db.transaction(() => {
        const writer = this.db.query('SELECT pid, token FROM writer WHERE id=1').get() as { pid: number; token: string } | null;
        requireThat(!writer || !alive(writer.pid), `Workflow database already has a live writer${writer ? ` (pid ${writer.pid})` : ''}`);
        this.db.query('INSERT OR REPLACE INTO writer(id,pid,token) VALUES(1,?,?)').run(process.pid, this.token);
        const canonicalRepo = resolve(repo);
        const row = (runId
          ? this.db.query('SELECT payload,sequence,hash FROM snapshots WHERE id=?').get(runId)
          : this.db.query('SELECT payload,sequence,hash FROM snapshots WHERE repo=? ORDER BY rowid DESC LIMIT 1').get(canonicalRepo)) as SnapshotRow | null;
        if (row) {
          this.stored = JSON.parse(row.payload) as Stored;
          requireThat(this.stored.state.repo === canonicalRepo, 'Run belongs to a different repository');
          if (runId) requireThat(this.stored.state.id === runId, 'Run identity mismatch');
          this.sequence = row.sequence;
          this.hash = row.hash;
          this.checkHistory(row);
        } else {
          this.stored = { state: { id: runId ?? randomUUID(), repo: canonicalRepo, status: 'planning', revision: 0, events: [], tasks: [], results: [], adoptions: [], actions: {} }, evidence: [], adoptionRevisions: {}, adoptionRefs: {}, paused: false, cancelled: false };
          this.reconciled = true;
          this.persist('created', this.stored);
        }
      }).immediate();
      if (!this.reconciled && this.stored.state.tasks.some(task => task.state === 'running')) {
        this.change('interrupted', data => {
          for (const task of data.state.tasks) if (task.state === 'running') { task.state = 'unknown'; task.error = 'Process interrupted; reconcile and recover the orphan attempt before restarting'; }
        });
      }
    } catch (error) {
      try { this.db.query('DELETE FROM writer WHERE token=?').run(this.token); } catch { /* Schema may not have been created. */ }
      this.db.close();
      throw error;
    }
  }

  get state(): RunState { return { ...copy(this.stored.state), integrationEvidence: copy(this.stored.evidence) }; }
  get planningEpoch(): number { return this.stored.planningEpoch ?? 0; }
  revokePlanning(): void { this.change('planning-revoked', data => { data.planningEpoch = (data.planningEpoch ?? 0) + 1; }); }

  close(): void {
    if (this.closed) return;
    this.db.query('DELETE FROM writer WHERE id=1 AND token=?').run(this.token);
    this.db.close();
    this.closed = true;
  }

  private checkHistory(snapshot: SnapshotRow): void {
    let previous = ''; let sequence = 0;
    const rows = this.db.query('SELECT sequence,action,at,payload,previous_hash,hash FROM history WHERE run_id=? ORDER BY sequence').all(this.stored.state.id) as { sequence: number; action: string; at: string; payload: string; previous_hash: string; hash: string }[];
    for (const row of rows) {
      requireThat(row.sequence === ++sequence && row.previous_hash === previous, 'Workflow history is discontinuous');
      requireThat(digest([row.sequence, row.action, row.at, row.payload, previous]) === row.hash, 'Workflow history checksum mismatch');
      previous = row.hash;
    }
    requireThat(sequence === snapshot.sequence && previous === snapshot.hash && rows.at(-1)?.payload === snapshot.payload, 'Workflow snapshot does not match append-only history');
  }

  private persist(action: string, data: Stored): void {
    const payload = JSON.stringify(data); const sequence = this.sequence + 1; const at = now();
    const hash = digest([sequence, action, at, payload, this.hash]);
    this.db.query('INSERT INTO history(run_id,sequence,action,at,payload,previous_hash,hash) VALUES(?,?,?,?,?,?,?)').run(data.state.id, sequence, action, at, payload, this.hash, hash);
    this.db.query('INSERT INTO snapshots(id,repo,payload,sequence,hash) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,sequence=excluded.sequence,hash=excluded.hash').run(data.state.id, data.state.repo, payload, sequence, hash);
    this.sequence = sequence; this.hash = hash;
  }

  private change<T>(action: string, apply: (data: Stored) => T): T {
    requireThat(!this.closed, 'Engine is closed');
    const oldSequence = this.sequence; const oldHash = this.hash;
    let next!: Stored;
    try {
      const result = this.db.transaction(() => {
        const writer = this.db.query('SELECT token FROM writer WHERE id=1').get() as { token: string } | null;
        requireThat(writer?.token === this.token, 'Workflow writer ownership was lost');
        const row = this.db.query('SELECT sequence,hash FROM snapshots WHERE id=?').get(this.stored.state.id) as { sequence: number; hash: string };
        requireThat(row.sequence === this.sequence && row.hash === this.hash, 'Concurrent workflow modification detected');
        next = copy(this.stored);
        const value = apply(next);
        this.persist(action, next);
        return value;
      }).immediate();
      this.stored = next;
      return copy(result);
    } catch (error) { this.sequence = oldSequence; this.hash = oldHash; throw error; }
  }

  private event(state: RunState, id: number): UserEvent {
    const event = state.events.find(item => item.id === id);
    requireThat(event, `Unknown input event ${id}`);
    return event;
  }
  private task(state: RunState, id: string): Task {
    const task = state.tasks.find(item => item.id === id);
    requireThat(task, `Unknown task ${id}`);
    return task;
  }
  private ready(data: Stored): void {
    requireThat(this.reconciled, 'Git reconciliation is required before effects');
    const state = data.state;
    requireThat(!state.events.some(event => !event.processed), 'Unclassified input fences effects');
    requireThat(state.plan && state.approval && state.approval.revision === state.plan.revision && state.approval.digest === state.plan.digest, 'Current plan is not approved');
    requireThat(!data.paused && !data.cancelled && !['planning', 'revising', 'completed', 'recovering'].includes(state.status), 'Run does not permit execution');
  }
  private versions(state: RunState, task: Pick<Task, 'requirementIds'|'id'>): Record<string, number> {
    requireThat(state.plan, 'No plan');
    const ids = new Set(task.requirementIds);
    for (const requirement of state.plan.requirements) if ((requirement.kind === 'constraint' || requirement.kind === 'exclusion') && (!requirement.scope || requirement.scope.includes(task.id))) ids.add(requirement.id);
    return Object.fromEntries([...ids].sort().map(id => {
      const requirement = state.plan!.requirements.find(item => item.id === id);
      requireThat(requirement, `Unknown requirement ${id}`);
      return [id, requirement.version];
    }));
  }
  private current(state: RunState, task: Task, epoch: number, attempt: number): boolean {
    return task.epoch === epoch && task.attempt === attempt && sameVersions(task.requirementVersions, this.versions(state, task));
  }
  private invalidate(state: RunState, task: Task): void {
    task.epoch++;
    if (task.state !== 'paused' && task.state !== 'cancelled') task.state = 'needs_revalidation';
    task.acknowledgedEvents = []; task.deliveredEvents = [];
    delete task.artifactCommit;
    for (const result of state.results) if (result.taskId === task.id && result.status !== 'stale') result.status = 'stale';
  }
  private closure(state: RunState, initial: string[]): Set<string> {
    const ids = new Set(initial);
    let changed = true;
    while (changed) { changed = false; for (const task of state.tasks) if (!ids.has(task.id) && task.dependencies.some(id => ids.has(id))) { ids.add(task.id); changed = true; } }
    return ids;
  }
  private requirements(state: RunState, incoming: Requirement[], sources: number[]): Requirement[] {
    requireThat(new Set(incoming.map(item => item.id)).size === incoming.length, 'Duplicate requirement IDs');
    const previous = state.plan?.requirements ?? [];
    const merged = new Map(previous.map(item => [item.id, copy(item)]));
    for (const requirement of incoming) {
      requireThat(requirement.id?.trim() && requirement.text?.trim(), 'Requirement ID and text are required');
      requireThat(['outcome', 'constraint', 'permission', 'exclusion', 'acceptance'].includes(requirement.kind), 'Invalid requirement kind');
      requireThat(requirement.sourceEventIds.length > 0 && new Set(requirement.sourceEventIds).size === requirement.sourceEventIds.length, 'Requirements need exact source event references');
      const prior = merged.get(requirement.id);
      for (const id of requirement.sourceEventIds) {
        requireThat(this.event(state, id).source === 'user', 'Control or tool material cannot grant user authority');
        requireThat(sources.includes(id) || prior?.sourceEventIds.includes(id), 'Requirement cites an input outside its declared sources');
      }
      const changed = !prior || prior.text !== requirement.text || prior.kind !== requirement.kind || digest(prior.scope ?? null) !== digest(requirement.scope ?? null);
      if (changed) requireThat(requirement.sourceEventIds.some(id => sources.includes(id) && !prior?.sourceEventIds.includes(id)), 'Changed requirement needs a new user source');
      merged.set(requirement.id, { ...copy(requirement), version: prior ? prior.version + Number(changed) : 1, sourceEventIds: unique([...(prior?.sourceEventIds ?? []), ...requirement.sourceEventIds]) });
    }
    return [...merged.values()];
  }

  receive(text: string, source: 'user' | 'control' = 'user', rawText?: string, attachments?:InputAttachment[], observational = false): UserEvent {
    requireThat(typeof text === 'string' && (text.trim() || attachments?.length), 'Input cannot be empty');
    requireThat(source === 'user' || source === 'control', 'Invalid input source');
    return this.change('receive', data => {
      const event: UserEvent = { id: (data.state.events.at(-1)?.id ?? 0) + 1, text, source, at: now(), processed: false, ...(rawText === undefined ? {} : { rawText }), ...(attachments?.length?{attachments:copy(attachments)}:{}), ...(observational?{observational:true}:{}) };
      data.state.events.push(event);
      if(!observational){delete data.state.finalReview;if(data.state.status==='completed')data.state.status='revising';}
      return event;
    });
  }
  processed(eventId: number,rejected?:string): void { this.change('classified', data => { const event=this.event(data.state,eventId);event.processed=true;if(rejected)event.rejected=rejected; }); }

  private requireCoverage(plan: PlanInput): void {
    for (const requirement of plan.requirements) if (requirement.kind === 'outcome' || requirement.kind === 'acceptance') requireThat(plan.work.some(work => work.requirementIds.includes(requirement.id)), `Required scope ${requirement.id} has no assigned work`);
  }
  propose(input: PlanInput, sourceEventIds: number[], planningEpoch = this.planningEpoch): Plan {
    return this.change('propose', data => {
      const state = data.state;
      requireThat(!data.paused && !data.cancelled, 'Resume the stopped run before planning');
      requireThat(planningEpoch === (data.planningEpoch ?? 0), 'Planning result belongs to a revoked request');
      requireThat(sourceEventIds.length && unique(sourceEventIds).length === sourceEventIds.length, 'Plan needs unique source inputs');
      for (const id of sourceEventIds) requireThat(this.event(state, id).source === 'user', 'Plan source must be actual user input');
      requireThat(input.title?.trim(), 'Plan needs a title');
      requireThat(new Set(input.work.map(work => work.id)).size === input.work.length, 'Duplicate work IDs');
      const requirements = this.requirements(state, input.requirements, sourceEventIds);
      const workIds = new Set(input.work.map(work => work.id));
      for (const work of input.work) {
        requireThat(work.id?.trim() && work.title?.trim() && work.instructions?.trim(), 'Work needs an ID, title and instructions');
        requireThat(work.requirementIds.length && work.requirementIds.every(id => requirements.some(requirement => requirement.id === id)), 'Work references missing requirements');
        requireThat(work.dependencies.every(id => workIds.has(id) && id !== work.id), 'Invalid work dependency');
        this.validateChecks(work.checks);
      }
      const visiting = new Set<string>(); const visited = new Set<string>();
      const visit = (id: string) => { requireThat(!visiting.has(id), 'Cyclic work dependencies'); if (visited.has(id)) return; visiting.add(id); for (const dependency of input.work.find(work => work.id === id)!.dependencies) visit(dependency); visiting.delete(id); visited.add(id); };
      for (const id of workIds) visit(id);
      this.validateChecks(input.checks);
      const revision = ++state.revision;
      const sources = unique([...(state.plan?.sourceEventIds ?? []), ...sourceEventIds]);
      const body: PlanInput = { ...copy(input), requirements };
      const plan: Plan = { ...body, revision, digest: planDigest(body, revision, sources), sourceEventIds: sources };
      const impacted = state.tasks.filter(task => {
        const next = plan.work.find(work => work.id === task.id);
        const old = state.plan?.work.find(work => work.id === task.id);
        return !next || digest(next) !== digest(old) || !sameVersions(task.requirementVersions, this.versions({ ...state, plan }, next));
      }).map(task => task.id);
      for (const id of this.closure(state, impacted)) this.invalidate(state, this.task(state, id));
      data.previousDisplay = state.plan?.displayedAt && data.displayCursor !== undefined ? {digest:state.plan.digest,cursor:data.displayCursor} : undefined;
      state.plan = plan; delete state.approval; delete state.finalReview; delete data.displayCursor;
      state.status = data.paused ? 'paused' : data.cancelled ? 'cancelled' : 'planning';
      return plan;
    });
  }
  displayed(): void { this.change('displayed', data => { requireThat(data.state.plan, 'No plan to display'); data.state.plan.displayedAt = now(); data.displayCursor = data.state.events.at(-1)?.id ?? 0; }); }

  private approvalGate(data:Stored,eventId:number,digestValue:string,amendedFromDigest?:string):{event:UserEvent;plan:Plan} {
    const state=data.state,event=this.event(state,eventId),plan=state.plan;
    requireThat(event.source === 'user' && !event.processed, 'Approval requires a pending actual user event');
    requireThat(plan?.displayedAt && plan.digest === digestValue, 'Approval must bind the exact displayed plan digest');
    requireThat(data.displayCursor !== undefined && (event.id > data.displayCursor || (amendedFromDigest && data.previousDisplay?.digest === amendedFromDigest && event.id > data.previousDisplay.cursor && plan.sourceEventIds.includes(event.id))), 'Approval input predates display and is not an explicit amendment to a displayed plan');
    requireThat(!state.events.some(item => !item.processed && item.id !== eventId), 'Other pending inputs must be classified before approval');
    requireThat(plan.questions.length === 0, 'Plan still contains unresolved questions');
    requireThat(plan.work.length > 0, 'An executable plan needs assigned work');
    this.requireCoverage(plan);
    return {event,plan};
  }
  validateApproval(eventId:number,digestValue:string,amendedFromDigest?:string):void {
    requireThat(!this.closed,'Engine is closed');
    this.approvalGate(this.stored,eventId,digestValue,amendedFromDigest);
  }

  approve(eventId: number, digestValue: string, amendedFromDigest?:string): void {
    this.change('approve', data => {
      const state=data.state,{event,plan}=this.approvalGate(data,eventId,digestValue,amendedFromDigest);
      state.approval = { eventId, digest: digestValue, revision: plan.revision, at: now() };
      const selected = new Set(plan.work.map(work => work.id));
      for (const task of state.tasks) if (!selected.has(task.id) && task.state !== 'cancelled') { this.invalidate(state, task); task.state = 'cancelled'; }
      const removed = state.tasks.filter(task => !selected.has(task.id));
      state.tasks = [...plan.work.map<Task>(work => {
        const prior = state.tasks.find(task => task.id === work.id);
        if (prior) return { ...prior, ...copy(work), requirementVersions: this.versions(state, work) };
        return { ...copy(work), epoch: 1, attempt: 0, state: 'pending', requirementVersions: this.versions(state, work), requiredEvents: [], deliveredEvents: [], acknowledgedEvents: [] };
      }), ...removed];
      event.processed = true;
      state.status = data.paused ? 'paused' : data.cancelled ? 'cancelled' : 'ready';
    });
  }

  startTask(id: string, workspace: Workspace): Task {
    return this.change('start-task', data => {
      this.ready(data); const state = data.state; const task = this.task(state, id);
      requireThat(state.plan!.work.some(work => work.id === id), 'Task is no longer in the approved assignment');
      requireThat(['pending', 'needs_revalidation', 'failed'].includes(task.state), `Task ${id} is not dispatchable`);
      requireThat(task.dependencies.every(dependency => ['verified', 'accepted'].includes(this.task(state, dependency).state)), 'Task dependencies are not verified');
      requireThat(workspace.path && workspace.branch && workspace.baseCommit, 'Workspace must have a path, branch and exact base commit');
      task.attempt++; task.state = 'running'; task.worktree = workspace.path; task.branch = workspace.branch; task.baseCommit = workspace.baseCommit;
      task.requirementVersions = this.versions(state, task);
      const applicable = state.plan!.requirements.filter(requirement => Object.hasOwn(task.requirementVersions,requirement.id));
      task.requiredEvents = unique([...task.requiredEvents,...applicable.flatMap(requirement=>requirement.sourceEventIds),state.approval!.eventId]).filter(id=>this.event(state,id).processed);
      task.deliveredEvents = [...task.requiredEvents]; task.acknowledgedEvents = [];
      delete task.sessionPath; delete task.pid; delete task.processToken; delete task.artifactCommit; delete task.error;
      state.status = 'executing';
      return task;
    });
  }
  setSession(id: string, info: SessionInfo): void {
    this.change('session', data => {
      const task = this.task(data.state, id); requireThat(task.state === 'running', 'Session belongs to no running attempt');
      requireThat(info.sessionPath && Number.isSafeInteger(info.pid) && info.pid > 0, 'Invalid worker session');
      task.sessionPath = info.sessionPath; task.pid = info.pid; task.processToken = `${this.token}:${task.epoch}:${task.attempt}`;
    });
  }
  acknowledge(id: string, epoch: number, attempt: number, eventIds: number[]): void {
    this.change('acknowledge', data => {
      const task = this.task(data.state, id);
      requireThat(task.state === 'running' && this.current(data.state, task, epoch, attempt), 'Acknowledgement belongs to a revoked attempt');
      requireThat(unique(eventIds).length === eventIds.length && equalSet(task.deliveredEvents, eventIds) && task.requiredEvents.every(event => eventIds.includes(event)), 'Acknowledgement must cover the exact delivered event set, without holes');
      requireThat(eventIds.every(event => this.event(data.state, event).processed), 'Cannot acknowledge unclassified input');
      task.acknowledgedEvents = [...eventIds];
    });
  }
  steer(eventId: number, change: SteeringChange): void {
    this.change('steer', data => {
      const state = data.state; const event = this.event(state, eventId);
      requireThat(event.source === 'user' && !event.processed, 'Steering requires pending actual user input');
      requireThat(state.plan && state.approval && state.approval.revision === state.plan.revision, 'No approved plan to steer');
      for (const id of change.impactedTaskIds) this.task(state, id);
      const resolved=change.resolvedEventIds??[];
      for(const id of resolved){const original=this.event(state,id);requireThat(id<eventId&&!original.processed&&original.source==='user','Clarification must reference earlier pending actual user input');}
      const requirements = this.requirements(state, change.requirements, [...resolved,eventId]);
      const priorAffected=this.closure(state,change.impactedTaskIds);
      const work=state.plan.work.map(spec=>change.work?.find(next=>next.id===spec.id)??spec);
      for(const spec of change.work??[]){requireThat(change.impactedTaskIds.includes(spec.id)&&state.plan.work.some(prior=>prior.id===spec.id),'Revised work must be in explicitly affected scope');this.validateChecks(spec.checks);}
      const nextPlan={...state.plan,requirements,work,checks:change.checks??state.plan.checks};
      this.validateChecks(nextPlan.checks);
      this.requireCoverage(nextPlan);
      const direct=state.tasks.filter(task=>!sameVersions(task.requirementVersions,this.versions({...state,plan:nextPlan},work.find(spec=>spec.id===task.id)??task))).map(task=>task.id);
      for(const task of state.tasks){const spec=change.work?.find(next=>next.id===task.id);if(spec)Object.assign(task,copy(spec));}
      const affected=this.closure(state,unique([...priorAffected,...direct,...change.impactedTaskIds]));
      requireThat(affected.size > 0 || change.requirements.length === 0, 'Steering scope has no applicable task');
      state.revision++; state.plan={...nextPlan,revision:state.revision};
      state.plan.sourceEventIds = unique([...state.plan.sourceEventIds,...resolved,eventId]);
      delete state.plan.displayedAt;
      const { revision, digest: _digest, sourceEventIds, displayedAt: _displayed, ...body } = state.plan;
      state.plan.digest = planDigest(body, revision, sourceEventIds);
      state.approval = { eventId, digest: state.plan.digest, revision, at: now() };
      for (const id of affected) {
        const task = this.task(state, id); this.invalidate(state, task);
        task.requirementVersions = this.versions(state, task);
        task.requiredEvents = unique([...task.requiredEvents, eventId]);
      }
      for(const id of resolved){const original=this.event(state,id);original.processed=true;original.resolvedBy=eventId;}
      delete state.finalReview;
      state.status = data.paused ? 'paused' : data.cancelled ? 'cancelled' : 'executing';
    });
  }

  pause(taskIds?: string[]): void { this.control('pause', taskIds); }
  resume(taskIds?: string[]): void { this.control('resume', taskIds); }
  cancel(taskIds?: string[]): void { this.control('cancel', taskIds); }
  private control(action: 'pause' | 'resume' | 'cancel', taskIds?: string[]): void {
    this.change(action, data => {
      const state = data.state;
      requireThat(state.status !== 'completed', 'Completed run must receive new user intent first');
      const selected = taskIds ? taskIds.map(id => this.task(state, id)) : state.tasks;
      const impacted = action === 'resume' ? new Set(selected.map(task => task.id)) : this.closure(state, selected.map(task => task.id));
      const tasks = state.tasks.filter(task => impacted.has(task.id));
      if (action === 'resume' && (state.approval || taskIds)) requireThat(this.reconciled && state.approval && state.approval.revision === state.plan?.revision, 'Resume requires reconciliation and a current approval');
      for (const task of tasks) {
        if (task.state === 'accepted' || !state.plan?.work.some(work => work.id === task.id)) continue;
        if (action === 'resume') {
          if (['paused', 'cancelled', 'unknown', 'failed'].includes(task.state)) { this.invalidate(state, task); task.state = 'pending'; delete task.error; }
        } else { this.invalidate(state, task); task.state = action === 'pause' ? 'paused' : 'cancelled'; }
      }
      if (!taskIds) { data.paused = action === 'pause'; data.cancelled = action === 'cancel'; }
      data.planningEpoch = (data.planningEpoch ?? 0) + 1;
      state.status = data.cancelled ? 'cancelled' : data.paused ? 'paused' : state.approval ? 'executing' : 'planning';
      delete state.finalReview;
    });
  }

  permit(taskId: string, epoch: number, attempt: number): boolean {
    try {
      requireThat(!this.closed, 'Engine is closed'); this.ready(this.stored);
      const task = this.task(this.stored.state, taskId);
      return task.state === 'running' && this.current(this.stored.state, task, epoch, attempt) && equalSet(task.deliveredEvents, task.acknowledgedEvents) && task.requiredEvents.every(id => task.acknowledgedEvents.includes(id));
    } catch { return false; }
  }
  recordResult(result: Result): void {
    this.change('result', data => {
      const state = data.state; const task = this.task(state, result.taskId);
      requireThat(result.artifactCommit && result.baseCommit && Number.isSafeInteger(result.epoch) && Number.isSafeInteger(result.attempt), 'Malformed result provenance');
      const valid = task.state === 'running' && this.current(state, task, result.epoch, result.attempt) && sameVersions(task.requirementVersions, result.requirementVersions) && equalSet(task.acknowledgedEvents, result.acknowledgedEvents) && task.requiredEvents.every(id => result.acknowledgedEvents.includes(id)) && task.baseCommit === result.baseCommit;
      requireThat(!state.results.some(item => item.taskId === result.taskId && item.epoch === result.epoch && item.attempt === result.attempt && !['stale', 'rejected'].includes(item.status)), 'Attempt already reported a result');
      const rejected = result.report.unmet.length > 0 || result.evidence.some(item => item.exitCode !== 0);
      state.results.push({ ...copy(result), status: valid ? rejected ? 'rejected' : 'pending' : 'stale' });
      if (valid) task.artifactCommit = result.artifactCommit;
    });
  }
  private result(state: RunState, task: Task): Result {
    const result = [...state.results].reverse().find(item => item.taskId === task.id && item.epoch === task.epoch && item.attempt === task.attempt && item.status !== 'stale');
    requireThat(result && this.current(state, task, result.epoch, result.attempt) && sameVersions(task.requirementVersions, result.requirementVersions) && task.baseCommit === result.baseCommit && task.artifactCommit === result.artifactCommit, 'No current result for task');
    requireThat(equalSet(result.acknowledgedEvents, task.acknowledgedEvents) && task.requiredEvents.every(id => result.acknowledgedEvents.includes(id)), 'Result acknowledgement is stale');
    return result;
  }
  private validateChecks(checks: Check[]): void { for (const check of checks) requireThat(Array.isArray(check.command) && check.command.length > 0 && check.command.every(part => typeof part === 'string' && part.length > 0), 'Checks require a nonempty argv command'); }
  private checked(checks: Check[], evidence: Evidence[], commit: string): void {
    for(const check of checks){
      const latest=[...evidence].reverse().find(item=>item.commit===commit&&digest(item.command)===digest(check.command));
      requireThat(latest?.exitCode===0,`Missing latest passing check at ${commit}: ${check.command.join(' ')}`);
    }
  }
  markVerified(taskId: string): void {
    this.change('verified', data => {
      this.ready(data); const task = this.task(data.state, taskId);
      requireThat(task.state === 'running', 'Task is not running');
      const result = this.result(data.state, task);
      requireThat(result.status === 'pending' && result.report.unmet.length === 0, 'Result has unmet work or is not pending');
      this.checked(task.checks, result.evidence, result.artifactCommit);
      task.state = 'verified'; result.status = 'verified';
    });
  }

  recordEvidence(evidence: Evidence[]): void {
    this.change('integration-evidence', data => {
      for (const item of evidence) {
        requireThat(item.commit && item.cwd && item.startedAt && item.endedAt && Number.isInteger(item.exitCode), 'Invalid integration check evidence');
        this.validateChecks([{ command: item.command, description: '' }]);
      }
      data.evidence.push(...copy(evidence)); delete data.state.finalReview;
    });
  }
  get integrationEvidence(): Evidence[] { return copy(this.stored.evidence); }

  prepareAdoption(taskIds: string[], oldHead: string, candidate: string): Adoption {
    return this.change('prepare-adoption', data => {
      this.ready(data); const state = data.state;
      requireThat(taskIds.length && unique(taskIds).length === taskIds.length && candidate, 'Adoption needs unique tasks and an exact candidate commit');
      requireThat(state.acceptedRef && state.acceptedHead === oldHead, 'Integration ref/head does not match expected base');
      requireThat(!state.adoptions.some(item => item.phase === 'prepared'), 'An adoption is already prepared');
      for (const id of taskIds) {
        const task = this.task(state, id); const result = this.result(state, task);
        requireThat(task.state === 'verified' && result.status === 'verified', 'Only current verified tasks can be adopted');
        requireThat(task.dependencies.every(dependency => taskIds.includes(dependency) || this.task(state, dependency).state === 'accepted'), 'Adoption omits an unaccepted dependency');
      }
      const adoption: Adoption = { id: randomUUID(), taskIds: [...taskIds], oldHead, candidate, inputCursor: state.events.at(-1)?.id ?? 0, epochs: Object.fromEntries(taskIds.map(id => [id, this.task(state, id).epoch])), phase: 'prepared' };
      state.adoptions.push(adoption); data.adoptionRevisions[adoption.id] = state.revision; data.adoptionRefs[adoption.id] = state.acceptedRef;
      return adoption;
    });
  }
  private adoptionGate(data: Stored, adoption: Adoption): void {
    this.ready(data); const state = data.state;
    requireThat(adoption.phase === 'prepared', 'Adoption is not prepared');
    requireThat(adoption.inputCursor === (state.events.at(-1)?.id ?? 0) && data.adoptionRevisions[adoption.id] === state.revision, 'Input or intent changed since adoption preparation');
    requireThat(state.acceptedHead === adoption.oldHead && state.acceptedRef === data.adoptionRefs[adoption.id], 'Adoption integration ref/base is stale');
    for (const id of adoption.taskIds) {
      const task = this.task(state, id); const result = this.result(state, task);
      requireThat(task.epoch === adoption.epochs[id] && task.state === 'verified' && result.status === 'verified', 'Adoption task was invalidated');
      this.checked(task.checks, data.evidence, adoption.candidate);
    }
  }
  private accepted(data: Stored, adoption: Adoption): void {
    adoption.phase = 'accepted'; data.state.acceptedHead = adoption.candidate;
    for (const id of adoption.taskIds) { const task = this.task(data.state, id); this.result(data.state, task).status = 'accepted'; task.state = 'accepted'; }
    delete data.state.finalReview;
    data.state.status = data.state.plan!.work.every(work => this.task(data.state, work.id).state === 'accepted') ? 'verifying' : 'executing';
  }
  acceptAdoption(id: string, publish?: () => void): void {
    let publicationStarted = false;
    try {
      this.change('accept-adoption', data => {
        const adoption = data.state.adoptions.find(item => item.id === id); requireThat(adoption, 'Unknown adoption');
        this.adoptionGate(data, adoption);
        if (publish) { publicationStarted = true; publish(); }
        this.accepted(data, adoption);
      });
    } catch (error) {
      if (publicationStarted) this.reconciled = false;
      throw error;
    }
  }
  abandonAdoption(id: string, reason: string): void {
    this.change('abandon-adoption', data => {
      const adoption = data.state.adoptions.find(item => item.id === id);
      requireThat(adoption?.phase === 'prepared', 'Only prepared adoption can be abandoned');
      adoption.phase = 'abandoned'; data.state.stopReason = reason;
    });
  }
  setAccepted(ref: string, head: string): void {
    this.change('integration-base', data => {
      requireThat(ref && head, 'Integration ref and head are required');
      requireThat(!data.state.acceptedHead || (data.state.acceptedHead === head && data.state.acceptedRef === ref), 'Existing accepted head can advance only through adoption');
      data.state.acceptedRef = ref; data.state.acceptedHead = head;
    });
  }
  setOriginalGit(snapshot: unknown): void {
    this.change('original-git', data => { requireThat(data.state.originalGit === undefined, 'Original Git snapshot is immutable'); data.state.originalGit = copy(snapshot); });
  }
  reconcile(actualHead: string): void {
    requireThat(actualHead, 'Reconciliation requires an actual Git commit');
    const previous = this.reconciled;
    this.reconciled = true;
    try {
      this.change('reconciled', data => {
        const state = data.state;
        const prepared = state.adoptions.filter(item => item.phase === 'prepared');
        requireThat(prepared.length <= 1, 'Multiple pending adoptions require recovery');
        const adoption = prepared[0];
        if (adoption && actualHead === adoption.candidate) { this.adoptionGate(data, adoption); this.accepted(data, adoption); }
        else {
          requireThat(!state.acceptedHead || actualHead === state.acceptedHead, 'Actual Git ref diverges from durable accepted head');
          if (adoption) { requireThat(actualHead === adoption.oldHead, 'Prepared adoption base diverged'); adoption.phase = 'abandoned'; }
        }
      });
    } catch (error) { this.reconciled = previous; throw error; }
  }
  recoverTask(id: string): void {
    this.change('recover-task', data => {
      requireThat(this.reconciled, 'Reconcile before recovering an orphan worker');
      const task = this.task(data.state, id); requireThat(task.state === 'unknown', 'Only orphaned unknown attempts can be recovered');
      this.invalidate(data.state, task); task.state = data.paused ? 'paused' : data.cancelled ? 'cancelled' : 'pending';
      delete task.pid; delete task.sessionPath; delete task.processToken;
    });
  }
  finalReview(commit: string, passed: boolean, findings: string[]): void {
    this.change('final-review', data => {
      this.ready(data);
      requireThat(commit === data.state.acceptedHead && data.state.plan!.work.every(work => this.task(data.state, work.id).state === 'accepted'), 'Final review must inspect fully accepted exact commit');
      data.state.finalReview = { commit, passed, findings: [...findings] };
    });
  }
  finish(): void {
    this.change('finished', data => {
      this.ready(data); const state = data.state;
      requireThat(state.tasks.length && state.plan!.work.every(work => this.task(state, work.id).state === 'accepted'), 'Required work is not all accepted');
      requireThat(state.acceptedHead && state.finalReview?.passed && state.finalReview.commit === state.acceptedHead, 'Exact accepted commit needs a passing raw-intent final review');
      requireThat(!state.adoptions.some(item => item.phase === 'prepared'), 'An adoption is still pending');
      this.checked([...state.plan!.checks, ...state.plan!.work.flatMap(work => work.checks)], data.evidence, state.acceptedHead);
      state.status = 'completed'; delete state.stopReason;
    });
  }
  failTask(id: string, error: string): void {
    this.change('task-failed', data => {
      const task = this.task(data.state, id);
      requireThat(!['accepted', 'cancelled', 'paused'].includes(task.state), 'Cannot change stopped or accepted task into failed');
      this.invalidate(data.state, task); task.state = 'failed'; task.error = error;
    });
  }
  requestCorrection(corrections: ReviewCorrection[], reviewTaskId?: string): string[] {
    return this.change('verification-correction', data => {
      this.ready(data); const state = data.state; let dependencies: Set<string> | undefined;
      if (reviewTaskId) {
        const review = this.task(state, reviewTaskId), result = this.result(state, review);
        requireThat(review.state === 'running' && review.writePaths.length === 0 && result.status === 'rejected', 'Subtask correction requires a current failed read-only review');
        dependencies = new Set<string>();
        const visit = (id: string) => { if (dependencies!.has(id)) return; dependencies!.add(id); for (const prior of this.task(state, id).dependencies) visit(prior); };
        for (const id of review.dependencies) visit(id);
      } else requireThat(state.finalReview?.passed === false && state.finalReview.commit === state.acceptedHead, 'Correction requires a failed exact-commit independent review');
      requireThat(corrections.length > 0 && new Set(corrections.map(item => item.taskId)).size === corrections.length, 'Correction needs unique approved tasks');
      for (const correction of corrections) {
        const spec = state.plan!.work.find(work => work.id === correction.taskId);
        requireThat(spec && correction.instructions.trim(), 'Correction cannot introduce new work or authority');
        const task = this.task(state, correction.taskId);
        requireThat(task.state === 'accepted' && (!dependencies || dependencies.has(task.id)), 'Correction must target accepted work within the review scope');
        task.instructions = `${spec.instructions}\n\nIndependent verification finding (not a new user requirement):\n${correction.instructions}\nRepair only within the approved requirements and write paths. Do not weaken checks, narrow the goal, or acquire new permissions.`;
      }
      const affected = this.closure(state, corrections.map(item => item.taskId));
      for (const id of affected) this.invalidate(state, this.task(state, id));
      delete state.finalReview; state.status = 'executing';
      return [...affected];
    });
  }
  progress(action: string, fingerprint: string, evidence: string): boolean {
    requireThat(action && fingerprint, 'Progress action and fingerprint are required');
    return this.change('progress', data => {
      const signatures = data.progressSignatures ??= {};
      const key = digest([action, fingerprint, evidence]);
      const repeats = signatures[key] ?? 0;
      signatures[key] = repeats + 1;
      data.state.actions[action] = { fingerprint, evidence, repeats };
      return repeats === 0;
    });
  }
}
