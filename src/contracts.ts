export type RunStatus = 'planning' | 'ready' | 'executing' | 'revising' | 'paused' | 'verifying' | 'completed' | 'cancelled' | 'recovering';
export type Role = 'lead' | 'heavy' | 'normal' | 'light' | 'reviewer';
export type RequirementKind = 'outcome' | 'constraint' | 'permission' | 'exclusion' | 'acceptance';
export interface InputAttachment { path: string; mimeType: string; sha256: string; }
export interface WorkflowImage { type: 'image'; data: string; mimeType: string; }
export interface UserEvent { id: number; text: string; source: 'user' | 'control'; at: string; processed: boolean; rawText?: string; resolvedBy?: number; attachments?: InputAttachment[]; rejected?: string; observational?: boolean; }
export interface Requirement { id: string; kind: RequirementKind; text: string; version: number; sourceEventIds: number[]; scope?: string[]; }
export interface Check { command: string[]; description: string; }
export interface WorkSpec { id: string; title: string; instructions: string; dependencies: string[]; requirementIds: string[]; writePaths: string[]; readPaths?: string[]; resources: string[]; checks: Check[]; role?: Role; model?: string; }
export interface PlanInput { title: string; summary: string; requirements: Requirement[]; assumptions: string[]; proposals: string[]; questions: string[]; work: WorkSpec[]; checks: Check[]; }
export interface Plan extends PlanInput { revision: number; digest: string; sourceEventIds: number[]; displayedAt?: string; }
export interface Approval { eventId: number; digest: string; revision: number; at: string; }
export interface Task extends WorkSpec { epoch: number; attempt: number; state: 'pending' | 'running' | 'paused' | 'cancelled' | 'needs_revalidation' | 'verified' | 'accepted' | 'failed' | 'unknown'; requirementVersions: Record<string, number>; requiredEvents: number[]; deliveredEvents: number[]; acknowledgedEvents: number[]; worktree?: string; branch?: string; baseCommit?: string; sessionPath?: string; pid?: number; processToken?: string; artifactCommit?: string; error?: string; }
export interface Evidence { command: string[]; executedCommand?: string[]; cwd: string; commit: string; exitCode: number; stdout: string; stderr: string; startedAt: string; endedAt: string; }
export interface WorkerReport { summary: string; completed: string[]; unmet: string[]; findings: string[]; pendingChecks: string[]; corrections: ReviewCorrection[]; }
export interface ReviewCorrection { taskId: string; instructions: string; }
export interface ReviewReport { passed: boolean; findings: string[]; corrections: ReviewCorrection[]; }
export interface Result { taskId: string; epoch: number; attempt: number; requirementVersions: Record<string, number>; acknowledgedEvents: number[]; artifactCommit: string; baseCommit: string; evidence: Evidence[]; report: WorkerReport; status: 'pending' | 'stale' | 'verified' | 'accepted' | 'rejected'; }
export interface Adoption { id: string; taskIds: string[]; oldHead: string; candidate: string; inputCursor: number; epochs: Record<string, number>; phase: 'prepared' | 'accepted' | 'abandoned'; }
export interface RunState { id: string; repo: string; status: RunStatus; revision: number; events: UserEvent[]; plan?: Plan; approval?: Approval; tasks: Task[]; results: Result[]; adoptions: Adoption[]; acceptedHead?: string; acceptedRef?: string; originalGit?: unknown; integrationEvidence?: Evidence[]; stopReason?: string; finalReview?: { commit: string; passed: boolean; findings: string[] }; actions: Record<string, { fingerprint: string; evidence: string; repeats: number }>; }
export interface SteeringChange { requirements: Requirement[]; impactedTaskIds: string[]; reason: string; work?: WorkSpec[]; checks?: Check[]; resolvedEventIds?: number[]; }
export interface WorkerConfig { cwd: string; sessionDir: string; model: string; thinking: 'low' | 'medium' | 'high' | 'xhigh'; purpose: 'planning' | 'implementation' | 'review'; context: string; sessionPath?: string; writePaths?: string[]; instructionRoot?: string; }
export interface PermitRequest { tool: string; input: unknown; }
export interface SessionInfo { sessionPath: string; pid: number; model: string; }
export interface SessionClient {
  readonly info: SessionInfo | undefined;
  start(): Promise<SessionInfo>;
  prompt(text: string, images?: WorkflowImage[]): Promise<string>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  setModel(selector: string): Promise<void>;
  close(): Promise<void>;
}
export type Permit = (request: PermitRequest) => boolean | string | Promise<boolean | string>;
export interface Workspace { path: string; branch: string; baseCommit: string; }
export interface GitSnapshot { head: string; branch: string; indexHash: string; trackedDiff: string; cachedDiff: string; untracked: Record<string, string>; }
export interface PlanningProgress { phase: 'starting' | 'thinking' | 'reading' | 'validating' | 'correcting' | 'error'; detail: string; }
export interface ControllerOptions { cwd: string; stateRoot?: string; model?: string; maxConcurrency?: number; onMessage?: (text: string) => void; onProgress?: (progress: PlanningProgress | undefined) => void; }
