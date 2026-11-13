import type { ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';
import type { EditorTheme, KeyId, TUI } from '@oh-my-pi/pi-tui';
import type { KeybindingsManager } from '@oh-my-pi/pi-tui/app-keybindings';
import { CustomEditor } from '@oh-my-pi/pi-tui/prompt/custom-editor';
import { expandEmoticons } from '@oh-my-pi/pi-tui/prompt/emoji-autocomplete';
import type { UserEvent, WorkflowImage } from '../contracts.ts';

export interface IngressController {
  receive(text: string, rawText?: string, images?:WorkflowImage[]): UserEvent;
  handle(event: UserEvent): Promise<string>;
}

/** Each snapshot belongs to an actual submission, never an editor change. */
export class RawSubmissions {
  private pending: { raw: string; submitted: string }[] = [];

  record(raw: string, submitted = raw.trim()): void {
    if (raw.length || submitted.trim()) this.pending.push({ raw, submitted: submitted.trim() });
  }

  take(text: string): string | undefined {
    const index = this.pending.findIndex(entry =>
      entry.submitted === text || expandEmoticons(entry.submitted) === text,
    );
    if (index < 0) return undefined;
    // Native continue shortcuts and other extensions can consume earlier submissions.
    return this.pending.splice(0, index + 1).at(-1)?.raw;
  }

  clear(): void { this.pending.length = 0; }
}

/** Keep the host's editor, keybindings, IME, paste serialization, and native composer. */
export class WorkflowEditor extends CustomEditor {
  private frames: string[] = [];

  constructor(
    private readonly submissions: RawSubmissions,
    private readonly keybindings: KeybindingsManager,
    private readonly interceptSubmit: (text: string, rawText: string) => boolean,
    ...args: ConstructorParameters<typeof CustomEditor>
  ) { super(...args); }

  private capture<T>(action: () => T): T {
    this.frames.push(this.getExpandedText());
    const outer = this.frames.length === 1;
    const submit = this.onSubmit;
    const altEnter = this.onAltEnter;
    const record = (text: string): void => {
      if (!this.composerState().viewing?.length) {
        this.submissions.record(this.frames.at(-1) ?? text, text);
      }
    };
    const wrappedSubmit = (text: string): void | Promise<void> => {
      const rawText = this.frames.at(-1) ?? text;
      if (!this.composerState().viewing?.length && this.interceptSubmit(text, rawText)) return;
      record(text);
      return submit?.(text);
    };
    const wrappedAltEnter = (text: string): void => {
      record(text);
      altEnter?.(text);
    };
    if (outer) {
      this.onSubmit = wrappedSubmit;
      if (altEnter) this.onAltEnter = wrappedAltEnter;
    }
    try { return action(); }
    finally {
      if (outer) {
        if (this.onSubmit === wrappedSubmit) this.onSubmit = submit;
        if (this.onAltEnter === wrappedAltEnter) this.onAltEnter = altEnter;
      }
      this.frames.pop();
    }
  }

  override handleInput(data: string): void { this.capture(() => super.handleInput(data)); }
  override handleDraftEdit(data: string): void { this.capture(() => super.handleDraftEdit(data)); }
  override submit(): void { this.capture(() => super.submit()); }

  override setCustomKeyHandler(key: KeyId, handler: () => void): void {
    const followUp = this.keybindings.getKeys('app.message.followUp').includes(key);
    super.setCustomKeyHandler(key, followUp ? () => {
      if (!this.composerState().viewing?.length) this.submissions.record(this.getExpandedText());
      handler();
    } : handler);
  }
}
export interface CaptureHandle { ():void; isCurrent():boolean; }

export function installRawCapture(
  ui: ExtensionUIContext,
  submissions: RawSubmissions,
  interceptSubmit: (text: string, rawText: string) => boolean = () => false,
): CaptureHandle | undefined {
  const previous = ui.getEditorComponent();
  if (previous) return undefined;
  const factory = (tui: TUI, theme: EditorTheme, keys: KeybindingsManager): CustomEditor =>
    new WorkflowEditor(submissions, keys, interceptSubmit, tui, theme, keys);
  ui.setEditorComponent(factory);
  const release=() => {
    submissions.clear();
    if (ui.getEditorComponent() === factory) ui.setEditorComponent(previous);
  };
  release.isCurrent=()=>ui.getEditorComponent()===factory;
  return release;
}

/** Durable admission is synchronous; model work never holds the native input hook. */
export function admit(
  controller: IngressController,
  text: string,
  rawText: string | undefined,
  output: (text: string) => void,
  failed: (error: unknown) => void,
  images?:WorkflowImage[],
): { handled: true } {
  const event = controller.receive(text, rawText, images);
  if (!/^\/workflow(?:\s+(?:status|plan))?\s*$/i.test(text.trim())) {
    output(`입력 #${event.id}을 저장했습니다. 처리 결과는 별도로 표시됩니다.`);
  }
  setImmediate(() => {
    void controller.handle(event).then(message => { if (message) output(message); }).catch(failed);
  });
  return { handled: true };
}
