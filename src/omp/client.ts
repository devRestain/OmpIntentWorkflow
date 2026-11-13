import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Permit, SessionClient, SessionInfo, WorkerConfig } from '../contracts.ts';

type Reply = { kind: string; id?: number; ok?: boolean; value?: unknown; error?: string; event?: unknown; request?: { tool: string; input: unknown } };
function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Each client owns one process group and one exact persistent OMP session. */
export function createSessionClient(config: WorkerConfig, permit?: Permit, onEvent?: (event: unknown) => void): SessionClient {
  let child: ChildProcess | undefined;
  let info: SessionInfo | undefined;
  let starting: Promise<SessionInfo> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let sequence = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let exited = false;
  let stopping: Promise<void> | undefined;
  let spawning: Promise<void> | undefined;
  let launched = false;
  let terminalError: Error | undefined;
  let termination: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const emit = (event: unknown) => { try { onEvent?.(event); } catch { /* Observation must not change admission. */ } };
  const fail = (error: Error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const send = (frame: object) => {
    if (!child?.connected || exited) throw new Error('OMP worker disconnected');
    child.send(frame, error => { if (error) void terminate(error); });
  };
  const groupPid = () => { const pid=child?.pid;return typeof pid==='number'&&Number.isSafeInteger(pid)&&pid>1?pid:undefined; };
  const groupAlive = () => {
    const pid=groupPid();if(pid===undefined)return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    const pid=groupPid();if(pid===undefined)return;
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const stop = (): Promise<void> => stopping ??= (async () => {
    clearInterval(heartbeat);
    if (!child) return;
    if (groupPid()===undefined) {
      if(launched)throw new Error('Worker spawned without a valid owned process-group PID; termination is unknown');
      emit({ type: 'worker_termination', launched: false, observed: true, at: new Date().toISOString() });
      return;
    }
    // Darwin can deny signalling an exiting group between IPC disconnect and exit.
    // Only observed disappearance, never signal delivery, establishes termination.
    let signalError: unknown;
    try { signalGroup('SIGTERM'); } catch (error) { signalError = error; }
    const gentleDeadline = Date.now() + 2_000;
    while ((!exited || groupAlive()) && Date.now() < gentleDeadline) await delay(25);
    if (!exited || groupAlive()) {
      try { signalGroup('SIGKILL'); } catch (error) { signalError = error; }
    }
    const hardDeadline = Date.now() + 3_000;
    while ((!exited || groupAlive()) && Date.now() < hardDeadline) await delay(25);
    const observed = exited && !groupAlive();
    emit({ type: 'worker_termination', pid: child.pid, observed, at: new Date().toISOString() });
    if (!observed) throw new Error('OMP worker process-tree termination was not observed', { cause: signalError });
  })();
  const terminate = (error: Error): Promise<void> => {
    if (termination) return termination;
    terminalError = error;
    closed = true;
    info = undefined;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    termination = (async () => {
      let failure = error;
      try { await stop(); }
      catch (cause) { failure = new AggregateError([error, cause], `${error.message}; worker termination was not observed`); }
      terminalError = failure;
      fail(failure);
    })();
    return termination;
  };
  const request = <T>(op: string, value?: unknown, timeout = 60_000): Promise<T> => {
    if (terminalError || (closed && op !== 'close')) return Promise.reject(terminalError ?? new Error('OMP client is closed'));
    const id = ++sequence;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      const error = new Error(`OMP worker ${op} timed out; process-tree termination requested`);
      emit({ type: 'operation_error', id, op, error: error.message, at: new Date().toISOString() });
      void terminate(error);
    }, timeout);
    pending.set(id, { resolve: result => resolve(result as T), reject, timer });
    try { send({ kind: 'request', id, op, value }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    return promise;
  };
  const handle = async (message: Reply) => {
    if (message.kind === 'event') { emit(message.event); return; }
    if (message.kind === 'permit' && typeof message.id === 'number') {
      const id = message.id;
      let decision: boolean | string = 'No parent permit callback is installed';
      const deadline = Promise.withResolvers<boolean | string>();
      const timer = setTimeout(() => deadline.resolve('Parent permit acknowledgement timed out'), 300_000);
      try {
        if (permit && message.request && !closed) {
          decision = await Promise.race([
            Promise.resolve(permit(message.request)),
            deadline.promise,
          ]);
        }
      } catch { decision = 'Parent permit callback failed'; }
      finally { clearTimeout(timer); }
      if (!child?.connected || exited) return;
      try { send({ kind: 'permit_result', id, allowed: !closed && decision === true, reason: typeof decision === 'string' ? decision : 'Parent denied tool execution' }); }
      catch { /* A disconnected worker cannot receive authority. */ }
      return;
    }
    if (message.kind !== 'response' || typeof message.id !== 'number') return;
    if (terminalError) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error ?? 'OMP worker operation failed'));
  };
  const start = (): Promise<SessionInfo> => {
    if (closed) return Promise.reject(terminalError ?? new Error('OMP client is closed'));
    if (starting) return starting;
    starting = (async () => {
      // A compiled OMP executable also reports process.versions.bun; it is not a script interpreter.
      const executable = Bun.which('bun');
      if (!executable) throw new Error('Bun is required to launch the OMP worker');
      const ready=Promise.withResolvers<void>();spawning=ready.promise;
      try {
        emit({ type: 'worker_starting', purpose: config.purpose, at: new Date().toISOString() });
        const worker=spawn(executable, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
          cwd: config.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
          env: { ...process.env, OMP_WORKFLOW_PARENT_PID: String(process.pid) },
        });
        child=worker;
        worker.once('spawn',()=>{launched=true;ready.resolve();});
        worker.on('error',error=>{ready.reject(error);void terminate(error);});
        // SDK diagnostics are not the protocol and may contain provider details.
        worker.stdout?.resume();worker.stderr?.resume();
        worker.on('message',message=>{void handle(message as Reply);});
        worker.on('disconnect',()=>{
          if(!closing)void terminate(new Error('OMP worker IPC disconnected'));
        });
        worker.on('exit',(code,signal)=>{
          exited=true;clearInterval(heartbeat);
          const error=new Error(`OMP worker exited (${signal??code})`);
          emit({type:'worker_exit',pid:worker.pid,code,signal,at:new Date().toISOString()});
          if(!closing)void terminate(error);else if(!terminalError)fail(error);
        });
        await ready.promise;
        if(groupPid()===undefined)throw new Error('OMP worker has no valid spawned PID');
        if(closed)throw new Error('OMP client closed during startup');
        heartbeat=setInterval(()=>{try{send({kind:'heartbeat'});}catch{/* Exit handler owns cleanup. */}},1_000);
        info=await request<SessionInfo>('start',config,120_000);
        if(info.pid!==worker.pid||!info.sessionPath||!info.model)throw new Error('Invalid worker startup acknowledgement');
        emit({type:'worker_started',...info,at:new Date().toISOString()});return info;
      } catch(error) {
        await terminate(error instanceof Error ? error : new Error(String(error)));
        throw terminalError;
      }
    })();
    return starting;
  };
  return {
    get info() { return info; },
    start,
    async prompt(text, images) { await start(); return request<string>('prompt', images?.length?{text,images}:text, 30 * 60_000); },
    async steer(text) { await start(); await request('steer', text); },
    async abort() {
      if(spawning)await spawning.catch(()=>undefined); // Startup reports its own error; cleanup still owns termination.
      if (!child || exited) return;
      if(!info){await terminate(new Error('OMP client aborted during startup'));return;}
      try { await request('abort', undefined, 10_000); }
      catch (error) { await terminate(error instanceof Error ? error : new Error(String(error))); throw error; }
    },
    async compact() { await start(); await request('compact', undefined, 5 * 60_000); },
    async setModel(selector) {
      await start();
      const model = await request<string>('setModel', selector);
      if (info) info = { ...info, model };
    },
    close() {
      return closing ??= (async () => {
        closed = true;
        let failure: unknown;
        try { if(spawning)await spawning.catch(()=>undefined);if(info&&child?.connected&&!exited)await request('close',undefined,10_000); }
        catch (error) { failure = error; }
        finally { try { await stop(); } finally { fail(terminalError ?? new Error('OMP client closed')); } }
        if (failure) throw failure;
      })();
    },
  };
}
