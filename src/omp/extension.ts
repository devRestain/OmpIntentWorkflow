import { z, type ExtensionAPI, type ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { PluginManager } from '@oh-my-pi/pi-coding-agent/extensibility/plugins';
import { Controller } from '../controller.ts';
import type { RunState, WorkflowImage } from '../contracts.ts';
import { admit, installRawCapture, RawSubmissions, type CaptureHandle } from './ingress.ts';
import { WorkflowWidget } from './progress.ts';

const PLUGIN = 'omp-intent-workflow';
const COMMANDS = ['status', 'plan', 'approve', 'pause', 'resume', 'cancel', 'tell', 'recover', 'new'];
const READ_ONLY_TOOLS: Record<string, true> = { read: true, glob: true, grep: true, web_search: true, web_fetch: true };
const FENCE = 'This workflow owns execution. Use /workflow pause, /workflow cancel, or /workflow tell; native effect tools, eval, MCP, and nested tasks cannot bypass plan approval or worktree isolation.';

export default function workflowExtension(pi: ExtensionAPI): void {
  let controller: Controller | undefined;
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let enabled = false;
  let editorReady = false;
  let claimed = false;
  let removeEditor: CaptureHandle | undefined;
  let unsubscribe: (() => void) | undefined;
  let initializationError: string | undefined;
  const raw = new RawSubmissions();
  const widget = new WorkflowWidget();
  let binding = 0;
  const refreshWidget = (): void => {
    if (context && enabled) context.ui.setWidget(PLUGIN, () => widget);
  };
  const clearProgress = (): void => { widget.setProgress(undefined); refreshWidget(); };

  const output = (text: string): void => {
    if (!text) return;
    pi.sendMessage({ customType: PLUGIN, content: text, display: true }, { triggerTurn: false });
  };
  const failed = (error: unknown): void => {
    clearProgress();
    output(`Workflow error: ${error instanceof Error ? error.message : String(error)}`);
  };
  const owns = (ctx: ExtensionContext): boolean => enabled && editorReady && claimed &&
    ctx.agent.kind === 'main' && ctx.sessionManager.getSessionId() === sessionId &&
    !!controller && controller.state.events.length > 0 &&
    !['completed', 'cancelled'].includes(controller.state.status);

  const project = (state: RunState): void => {
    if (!context || !enabled) return;
    const accepted = state.tasks.filter(task => task.state === 'accepted').length;
    context.ui.setStatus(PLUGIN, `Workflow ${state.status} · ${accepted}/${state.tasks.length}`);
    widget.setState(state);
    refreshWidget();
  };

  const dispose = async (): Promise<void> => {
    binding++;
    widget.clear();
    enabled = false;
    editorReady = false;
    claimed = false;
    sessionId = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    removeEditor?.();
    removeEditor = undefined;
    raw.clear();
    context?.ui.setStatus(PLUGIN, undefined);
    context?.ui.setWidget(PLUGIN, undefined);
    const old = controller;
    controller = undefined;
    await old?.close();
  };

  const setup = async (ctx: ExtensionContext): Promise<void> => {
    await dispose();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    initializationError = undefined;
    if (ctx.agent.kind !== 'main') return;
    try {
      const manager = new PluginManager(ctx.cwd);
      const [settings, installed] = await Promise.all([
        manager.getPluginSettings(PLUGIN), manager.getPlugin(PLUGIN),
      ]);
      enabled = settings.enabled !== false && installed?.enabled !== false;
      if (!enabled) return;
      if (ctx.mode === 'tui') {
        removeEditor = installRawCapture(ctx.ui, raw, (text, rawText) => {
          // Native continue shortcuts bypass input hooks; admit them before that shortcut runs.
          if (!owns(ctx) || !['.', 'c'].includes(text)) return false;
          dispatch(text, rawText, ctx);
          return true;
        });
        editorReady = !!removeEditor;
        if (!editorReady) {
          initializationError = 'Another extension owns the custom editor. Workflow did not replace it and will not take input. Resolve the editor conflict and reload to retain exact submitted text.';
          ctx.ui.notify(initializationError, 'warning');
          return;
        }
      } else {
        // Non-TUI input is already original text; there is no terminal normalization to undo.
        editorReady = true;
      }
      const boundSessionId = sessionId;
      const boundGeneration = binding;
      const concurrency=await pi.exec('omp',['config','get','task.maxConcurrency','--json'],{cwd:ctx.cwd,timeout:10000});
      if(concurrency.code!==0||concurrency.killed)throw new Error('Cannot read native task concurrency policy');
      const nativeLimit=z.object({value:z.number().int().min(1)}).parse(JSON.parse(concurrency.stdout)).value;
      controller = new Controller({
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        maxConcurrency:nativeLimit,
        onMessage: message => { if (sessionId === boundSessionId && binding === boundGeneration) output(message); },
        onProgress: progress => {
          if (sessionId !== boundSessionId || binding !== boundGeneration) return;
          widget.setProgress(progress);
          refreshWidget();
        },
      });
      await controller.initialize();
      unsubscribe = controller.onChange(project);
      project(controller.state);
    } catch (error) {
      initializationError = error instanceof Error ? error.message : String(error);
      failed(error);
    }
  };

  const conflict = (ctx: ExtensionContext): string | undefined => {
    const modes = ctx.sessionModes?.getState();
    if (!modes) return undefined;
    const active = Object.entries(modes).filter(([, value]) => value.status !== 'inactive').map(([name]) => `/${name}`);
    return active.length ? `Workflow cannot take over while native ${active.join(', ')} is active or paused. Exit that mode explicitly; its state was not changed.` : undefined;
  };

  const dispatch = (text: string, rawText: string | undefined, ctx: ExtensionContext, images?:WorkflowImage[]): { handled: true } => {
    const match = /^\/workflow(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    const action = match?.[1]?.toLowerCase() ?? 'status';
    if (match && !COMMANDS.includes(action)) {
      output(`Usage: /workflow ${COMMANDS.join('|')}`);
      return { handled: true };
    }
    if (!enabled) {
      output('Workflow is disabled in native plugin settings. Enable it and reload; native input remains unchanged.');
      return { handled: true };
    }
    if (!editorReady || !controller || initializationError) {
      output(`Workflow unavailable: ${initializationError ?? 'initialization has not completed'}`);
      return { handled: true };
    }
    if ((!match || ['plan', 'approve', 'resume', 'recover', 'new', 'tell'].includes(action))) {
      const reason = conflict(ctx);
      if (reason) {
        output(reason);
        return { handled: true };
      }
    }
    try {
      if (match && ['pause', 'cancel', 'new', 'recover'].includes(action)) clearProgress();
      const boundSessionId = sessionId;
      const result = admit(controller, text, rawText,
        message => { if (sessionId === boundSessionId) output(message); },
        error => { if (sessionId === boundSessionId) failed(error); },images);
      if (!match || action !== 'status') claimed = true;
      return result;
    } catch (error) {
      failed(error);
      return { handled: true };
    }
  };

  pi.registerCommand('workflow', {
    description: 'Plan, approve, steer, pause, or recover the durable worktree workflow',
    getArgumentCompletions: prefix => COMMANDS.filter(command => command.startsWith(prefix)).map(command => ({ value: command, label: command })),
    handler: async (args, ctx) => { dispatch(`/workflow ${args}`.trimEnd(), undefined, ctx); },
  });

  pi.on('session_start', (_event, ctx) => setup(ctx));
  pi.on('session_switch', (_event, ctx) => setup(ctx));
  pi.on('session_branch', (_event, ctx) => setup(ctx));
  pi.on('session_shutdown', () => dispose());

  pi.on('input', async (event, ctx) => {
    const rawText = event.source === 'interactive' ? raw.take(event.text) : event.text;
    if (ctx.agent.kind !== 'main') return;
    // The native settings overlay and CLI are authoritative, including changes during a session.
    try {
      const manager = new PluginManager(ctx.cwd);
      const [settings, installed] = await Promise.all([manager.getPluginSettings(PLUGIN), manager.getPlugin(PLUGIN)]);
      const nextEnabled = settings.enabled !== false && installed?.enabled !== false;
      if (!nextEnabled && enabled) await dispose();
      else if (nextEnabled && !enabled) {
        ctx.ui.notify('Workflow was enabled. Reload extensions or start a new OMP session to install lossless input capture; this input remains native.', 'info');
        return;
      }
    } catch (error) {
      failed(error);
      return enabled ? { handled: true } : undefined;
    }
    const text = event.text;
    if (!enabled) return;
    if(ctx.mode==='tui'&&!removeEditor?.isCurrent()){
      editorReady=false;
      if(controller){controller.receive(event.text,rawText,event.images);claimed=true;}
      ctx.ui.setEditorText(event.text);
      output('Workflow input is preserved but not executed: another extension replaced its editor. Exact pre-normalization capture is unavailable. Restore editor ownership and reload before continuing.');
      return {handled:true};
    }
    if (/^\/workflow(?:\s|$)/i.test(text)) return dispatch(text, rawText, ctx,event.images);
    if(/^\/skill:[A-Za-z0-9_.:-]+(?:\s|$)/.test(text))return dispatch(text,rawText,ctx,event.images);
    if (!editorReady) return;
    if (/^\/(?:plan|goal|guided-goal|vibe|loop)(?:\s|$)/i.test(text) && owns(ctx)) {
      output('The workflow owns this run. /workflow pause keeps ownership; /workflow cancel releases it before using native /plan or /goal. No native mode was changed.');
      return { handled: true };
    }
    if (text.trimStart().startsWith('/')) return;
    const reason = conflict(ctx);
    if (reason) {
      ctx.ui.notify(reason, 'warning');
      return; // The user's already-active native mode retains its normal input.
    }
    return dispatch(text, rawText, ctx,event.images);
  });

  pi.on('tool_call', (_event, ctx) => {
    if (owns(ctx) && !Object.hasOwn(READ_ONLY_TOOLS, _event.toolName)) return { block: true, reason: FENCE };
  });
  pi.on('before_subagent_spawn', (_event, ctx) => {
    if (owns(ctx)) return { block: true, reason: FENCE };
  });
  pi.on('user_bash', (_event, ctx) => {
    if (owns(ctx)) return { result: {
      output: FENCE, exitCode: 1, cancelled: true, truncated: false,
      totalLines: 1, outputLines: 1, totalBytes: Buffer.byteLength(FENCE), outputBytes: Buffer.byteLength(FENCE),
    } };
  });
  pi.on('user_python', (_event, ctx) => {
    if (owns(ctx)) return { result: {
      output: FENCE, exitCode: 1, cancelled: true, truncated: false,
      totalLines: 1, outputLines: 1, totalBytes: Buffer.byteLength(FENCE), outputBytes: Buffer.byteLength(FENCE),
      displayOutputs: [], stdinRequested: false,
    } };
  });
  pi.on('mode_changed', (event, ctx) => {
    if (!owns(ctx) || Object.values(event.state).every(mode => mode.status === 'inactive')) return;
    output('A native mode became active. Workflow is pausing without changing that native mode.');
    void controller?.command('pause').then(output).catch(failed);
  });
}
