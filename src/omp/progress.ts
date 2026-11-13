import { isAbsolute, relative, resolve, sep } from 'node:path';
import { truncateToWidth, visibleWidth } from '@oh-my-pi/pi-tui';
import type { PlanningProgress, RunState } from '../contracts.ts';
import { redactForModel, sensitivePath } from '../safety.ts';

const PHASES: Record<PlanningProgress['phase'], string> = {
  starting: '시작', thinking: '기획 중', reading: '자료 확인', validating: '계획 검증', correcting: '계획 보완', error: '오류',
};

function displayText(value: string, limit = 160): string {
  return redactForModel(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\b(?:Bearer\s+\S+|(?:api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Only an explicit user-facing label and a scoped path may leave the worker. */
export function toolProgressDetail(tool: string, input: Record<string, unknown>, root: string): string {
  const action = ({ read: 'Reading', read_history: 'Reading committed file', grep: 'Searching', glob: 'Finding files', edit: 'Editing', write: 'Writing', bash: 'Inspecting repository' } as Record<string, string>)[tool] ?? 'Inspecting workspace';
  const label = typeof input.i === 'string' ? input.i.trim() : '';
  const intent = /^(?:Reading|Searching|Finding|Locating|Inspecting|Checking|Reviewing|Listing|Loading|Updating|Editing|Writing|Removing|Comparing|Validating)\b[\p{L} -]{1,64}$/iu.test(label) && label.split(/\s+/).length <= 8 && !/\b(?:password|token|secret|credential|bearer|authorization|api key)s?\b/i.test(label)
    ? displayText(label, 72) : action;
  let target = '';
  if (typeof input.path === 'string' && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069?#]/.test(input.path)) {
    if (/^skill:\/\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(input.path) && !input.path.split('/').includes('..')) {
      target = input.path;
    } else if (!input.path.includes(':')) {
      const scoped = relative(root, resolve(root, input.path));
      if (!isAbsolute(scoped) && scoped !== '..' && !scoped.startsWith('..' + sep)) target = scoped.split(sep).join('/') || '.';
    }
    if (sensitivePath(target)) target = '[protected path]';
  }
  return `${intent}${target ? ` · ${displayText(target, 110)}` : ''}`;
}

/** One root component retains only the current activity, never a tool history. */
export class WorkflowWidget {
  private state: RunState | undefined;
  private progress: PlanningProgress | undefined;

  setState(state: RunState): void {
    this.state = state;
    if (!['planning', 'revising', 'recovering'].includes(state.status) || state.stopReason) this.progress = undefined;
  }

  setProgress(progress: PlanningProgress | undefined): void {
    this.progress = this.state && (!['planning', 'revising', 'recovering'].includes(this.state.status) || this.state.stopReason) ? undefined : progress;
  }
  clear(): void { this.state = undefined; this.progress = undefined; }
  invalidate(): void {}

  render(width: number): string[] {
    if (!this.state || width < 1) return [];
    const state = this.state;
    const accepted = state.tasks.filter(task => task.state === 'accepted').length;
    const pending = state.events.filter(event => !event.processed).length;
    const lines = [
      `Workflow: ${state.status}${state.plan ? ` · plan r${state.plan.revision}` : ' · 기획 미작성'} · ${accepted}/${state.tasks.length} accepted`,
      `미처리 입력: ${pending}건`,
    ];
    if (this.progress) {
      lines.push(`기획 활동: ${PHASES[this.progress.phase]}`, displayText(this.progress.detail));
    } else {
      lines.push(displayText(state.stopReason ?? (state.status === 'paused'
        ? '일시정지됨: /workflow resume으로 재개합니다.'
        : state.status === 'cancelled'
          ? '취소됨: /workflow new <목표>로 새 기획을 시작합니다.'
          : !state.plan && pending
            ? '기획 미완료: /workflow recover로 복구합니다.'
            : '표시된 계획만 승인 후 실행합니다. /workflow plan · status · pause · tell')));
    }
    if (width < 4) return lines.map(line => truncateToWidth(line, width));
    const inner = width - 4;
    const row = (line: string) => {
      const text = truncateToWidth(line, inner);
      return `│ ${text}${' '.repeat(Math.max(0, inner - visibleWidth(text)))} │`;
    };
    return [`┌${'─'.repeat(width - 2)}┐`, ...lines.map(row), `└${'─'.repeat(width - 2)}┘`];
  }
}
