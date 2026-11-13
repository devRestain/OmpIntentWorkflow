import { expect, test } from 'bun:test';
import { visibleWidth } from '@oh-my-pi/pi-tui';
import type { RunState, RunStatus } from '../src/contracts.ts';
import { toolProgressDetail, WorkflowWidget } from '../src/omp/progress.ts';

const root = '/fixture/workspace';
const state = (status: RunStatus = 'planning'): RunState => ({
  id: 'fixture', repo: root, status, revision: 0, events: [], tasks: [], results: [], adoptions: [], actions: {},
});

test('planning activity names the scoped target without exposing tool payloads', () => {
  const detail = toolProgressDetail('grep', {
    path: root + '/Core/src', i: 'Searching source contracts',
    pattern: 'PRIVATE QUERY sk-' + 'x'.repeat(40), content: 'PRIVATE FILE CONTENT',
    argv: ['echo', 'PRIVATE COMMAND'], reasoning: 'PRIVATE MODEL THOUGHT',
  }, root);
  expect(detail).toBe('Searching source contracts · Core/src');
  expect(detail).not.toContain(root);
  expect(detail).not.toContain('PRIVATE');
  expect(toolProgressDetail('read', { path: 'Core/AGENTS.md' }, root)).toBe('Reading · Core/AGENTS.md');
  expect(toolProgressDetail('read_history', { path: 'Core/src/contracts.ts' }, root)).toContain('Reading committed file · Core/src/contracts.ts');
  expect(toolProgressDetail('read', { path: 'skill://project-contract/references/work.md' }, root)).toContain('skill://project-contract/references/work.md');
  expect(toolProgressDetail('glob', { path: '.' }, root)).toBe('Finding files · .');
});

test('activity rejects unsafe labels and hides external, credential and control targets', () => {
  for (const path of ['/Users/private/account.txt', '../outside', 'https://user:pass@example.test/query?secret=value', 'src/file\nPRIVATE', 'src/\x1b[31mPRIVATE', 'src/\u202ePRIVATE']) {
    const detail = toolProgressDetail('read', { path, i: 'I think PRIVATE reasoning should be copied' }, root);
    expect(detail).toBe('Reading');
  }
  expect(toolProgressDetail('read', { path: '.env.production' }, root)).toBe('Reading · [protected path]');
  expect(toolProgressDetail('read', { path: 'credentials.json' }, root)).not.toContain('credentials.json');
  const token = 'sk-' + 'x'.repeat(40);
  expect(toolProgressDetail('read', { path: 'src/' + token, i: 'Reading token huntertwo' }, root)).not.toContain(token);
  expect(toolProgressDetail('read', { path: 'src/safe.ts', i: 'Reading token huntertwo' }, root)).not.toContain('huntertwo');
  expect(toolProgressDetail('grep', { path: '.', i: 'Searching ' + 'private '.repeat(30) }, root)).toBe('Searching · .');
});

test('long planning sequences replace the visible activity with a bounded box', () => {
  const widget = new WorkflowWidget();
  widget.setState(state());
  for (let index = 0; index < 250; index++) {
    widget.setProgress({ phase: 'reading', detail: toolProgressDetail('read', { path: `Core/src/file-${index}.ts`, i: 'Reading source contract' }, root) });
    const lines = widget.render(100);
    expect(lines).toHaveLength(6);
    expect(lines[0]?.startsWith('┌')).toBe(true);
    expect(lines.join('\n')).toContain(`Core/src/file-${index}.ts`);
    if (index) expect(lines.join('\n')).not.toContain(`Core/src/file-${index - 1}.ts`);
  }
  widget.setProgress({ phase: 'validating', detail: '요구사항 출처와 실행 범위를 확인합니다.' });
  expect(widget.render(100).join('\n')).toContain('계획 검증');
  expect(widget.render(100).join('\n')).not.toContain('file-249');
  for (const width of [1, 2, 3, 4, 12, 30, 100]) {
    for (const line of widget.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test('stop, error, completion, clear and fresh state do not retain stale activity', () => {
  const widget = new WorkflowWidget();
  for (const status of ['paused', 'cancelled', 'completed', 'ready', 'executing'] as const) {
    widget.setState(state());
    widget.setProgress({ phase: 'reading', detail: 'OLD ACTIVITY' });
    widget.setState(state(status));
    widget.setProgress({ phase: 'thinking', detail: 'LATE ACTIVITY' });
    expect(widget.render(100).join('\n')).not.toContain('ACTIVITY');
  }
  widget.setState(state());
  widget.setProgress({ phase: 'error', detail: 'Provider unavailable' });
  expect(widget.render(100).join('\n')).toContain('오류');
  widget.setState({ ...state(), stopReason: 'Planning stopped; recover explicitly.' });
  expect(widget.render(100).join('\n')).not.toContain('Provider unavailable');
  expect(widget.render(100).join('\n')).toContain('recover explicitly');
  widget.clear();
  expect(widget.render(100)).toEqual([]);
  widget.setState(state());
  expect(widget.render(100).join('\n')).not.toContain('기획 활동');
  widget.setProgress({ phase: 'starting', detail: 'Starting fresh planning' });
  widget.setProgress(undefined);
  expect(widget.render(100).join('\n')).not.toContain('Starting fresh');
});

test('the actual rendered detail stays single-line and redacts credential-like text', () => {
  const widget = new WorkflowWidget();
  widget.setState(state());
  widget.setProgress({ phase: 'reading', detail: 'Reading source\n\x1b[31m api_key=huntertwo Bearer opaque-value sk-' + 'x'.repeat(40) + '\u202e' });
  const lines = widget.render(100);
  const rendered = lines.join('\n');
  expect(lines).toHaveLength(6);
  expect(rendered).not.toContain('huntertwo');
  expect(rendered).not.toContain('opaque-value');
  expect(rendered).not.toContain('x'.repeat(40));
  expect(rendered).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
});
