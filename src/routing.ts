import type { Role } from './contracts';

export function route(role: Role, preferred?: string): { model: string; thinking: 'low' | 'medium' | 'high' | 'xhigh' } {
  const effort = { lead: 'high', heavy: 'xhigh', normal: 'medium', light: 'low', reviewer: 'high' } as const;
  if (!Object.hasOwn(effort, role)) throw new Error(`Unknown workflow role: ${role}`);
  if (preferred !== undefined && !preferred.trim()) throw new Error('An explicit model selector cannot be empty');
  // Terra (openai-codex/gpt-6.1-terra) is opt-in until actual inference evaluation warrants a default change.
  return { model: preferred ?? 'openai-codex/gpt-6.1-sol', thinking: effort[role] };
}
