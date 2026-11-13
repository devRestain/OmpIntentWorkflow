import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real client launches the real worker over IPC. Only the SDK/provider boundary
// is replaced in a disposable child, so these checks never read native auth or sessions.
const clientUrl = new URL('../src/omp/client.ts', import.meta.url).href;
const zodUrl = pathToFileURL(Bun.resolveSync('zod', fileURLToPath(new URL('..', import.meta.url)))).href;
const sdkUrl = pathToFileURL(Bun.resolveSync('@oh-my-pi/pi-coding-agent', fileURLToPath(new URL('..', import.meta.url)))).href;
const preload = `
import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from ${JSON.stringify(zodUrl)};
const model = { provider: 'fixture', id: 'model' };
class Manager {
  constructor(root, dir) { this.root = root; this.filename = join(dir, 'fixture.jsonl'); }
  static create(root, dir) { return new Manager(root, dir); }
  getCwd() { return this.root; }
  async ensureOnDisk() { writeFileSync(this.filename, 'fixture-only\\n'); }
  async flush() {}
  async close() {}
}
mock.module(${JSON.stringify(sdkUrl)}, () => ({
  z, SessionManager: Manager,
  Settings: { loadReadOnly: async () => ({ overlay: () => ({}) }) },
  discoverAuthStorage: async () => ({}), discoverContextFiles: async () => [], discoverSkills: async () => ({ skills: [] }),
  getAgentDir: () => process.cwd(),
  ModelRegistry: class { async hydrateCredentialScopedModelCaches() {} find() { return model; } getAll() { return [model]; } },
  createAgentSession: async options => {
    if (options.systemPrompt.includes('startup-block')) await Promise.withResolvers().promise;
    const listeners = new Set(); const hooks = new Map(); let release;
    const emit = event => { for (const listener of listeners) listener(event); };
    const session = {
      model, messages: [], sessionFile: options.sessionManager.filename,
      getEnabledToolNames: () => options.customTools.map(tool => tool.name),
      getAllToolInfos: () => options.customTools.map(tool => ({ ...tool, sourceInfo: { source: 'extension' } })),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      beginDispose() {}, async dispose() {}, async abort() { release?.(); }, async steer() {},
      async prompt(text) {
        emit({ type: 'agent_start' });
        hooks.get('before_provider_request')?.({});
        let answer = 'answer DO_NOT_LOG';
        if (text === 'nested-history') {
          const execute = async (name, input) => (await options.customTools.find(tool => tool.name === name).execute('nested-' + name, input, undefined, undefined, new AbortController().signal)).content[0].text;
          answer = JSON.stringify({
            history: await execute('read_history', { path: 'nested/file.txt', commit: 'HEAD', i: 'Reading original source' }),
            current: await execute('read', { path: 'nested/file.txt' }),
            show: await execute('bash', { argv: ['git', 'show', 'HEAD:nested/file.txt'] }),
          });
        }
        if (text === 'exit') process.exit(7);
        if (text === 'timeout') await Promise.withResolvers().promise;
        if (text === 'hold') {
          emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'held' });
          const pending = Promise.withResolvers(); release = pending.resolve;
          await pending.promise;
          // Leave a real event-loop unwind after abort, without guessing a delay.
          const unwound = Promise.withResolvers(); setImmediate(unwound.resolve);
          await unwound.promise;
        }
        if (text === 'tool') {
          emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'fixture' });
          emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', arguments: { secret: 'DO_NOT_LOG' } }] } });
          emit({ type: 'tool_execution_end', toolName: 'read', toolCallId: 'fixture', isError: false, result: 'DO_NOT_LOG' });
        }
        if (text === 'error') {
          emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: 'quota exhausted' });
          emit({ type: 'auto_retry_end', attempt: 1, success: false, finalError: 'quota exhausted' });
        }
        const message = { role: 'assistant', stopReason: text === 'error' ? 'error' : text === 'hold' ? 'aborted' : 'stop',
          errorMessage: text === 'error' ? 'quota exhausted sk-' + 'x'.repeat(40) : undefined,
          content: [{ type: 'text', text: text === 'empty' ? '' : answer }] };
        emit({ type: 'message_end', message }); emit({ type: 'agent_end', messages: [message] });
        hooks.get('after_provider_response')?.({});
        return true;
      },
    };
    for (const extension of options.preloadedPreparedExtensions) extension.factory({ on(name, fn) { hooks.set(name, fn); } });
    return { session, extensionsResult: { errors: [] } };
  },
}));
`;

const host = `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createSessionClient } from ${JSON.stringify(clientUrl)};
const scenario = Bun.argv[2];
const realTimeout = globalThis.setTimeout;
// Exercise the real request deadline/OS process-group shutdown, not a fake clock.
if (scenario === 'timeout') globalThis.setTimeout = ((callback, ms, ...args) => realTimeout(callback, ms === 30 * 60_000 ? 100 : ms, ...args));
const events = [];
const held = Promise.withResolvers();
if (scenario === 'nested-history') {
  const command = (cwd, args) => { const result = Bun.spawnSync(['git', ...args], {cwd}); assert.equal(result.exitCode, 0, result.stderr.toString()); };
  for (const directory of [process.cwd(), join(process.cwd(), 'nested')]) {
    mkdirSync(directory, {recursive:true});command(directory,['init','-b','main']);
    writeFileSync(join(directory,'file.txt'),directory === process.cwd() ? 'root-history\\n' : 'nested-history\\n');
    command(directory,['add','file.txt']);command(directory,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']);
  }
  writeFileSync(join(process.cwd(),'nested/file.txt'),'nested-working\\n');
}
const client = createSessionClient({ cwd: process.cwd(), sessionDir: join(process.cwd(), 'sessions'), model: 'fixture/model', thinking: 'low', purpose: scenario === 'nested-history' ? 'implementation' : 'planning', writePaths: scenario === 'nested-history' ? ['nested/file.txt'] : [], context: scenario === 'startup' ? 'startup-block' : 'fixture' }, () => true, event => {
  events.push(event);
  if (event.type === 'tool_execution_start' || (scenario === 'startup' && event.type === 'operation_start' && event.op === 'start')) held.resolve();
});
try {
  if (scenario === 'startup') {
    const starting = client.start().then(() => { throw new Error('Startup unexpectedly completed'); }, error => error);
    await held.promise; await client.abort();
    assert.match((await starting).message, /aborted during startup/);
    await assert.rejects(client.start(), /aborted during startup/);
    assert.equal(client.info, undefined);
  } else {
    await client.start();
    if (scenario === 'nested-history') {
      const result = JSON.parse(await client.prompt('nested-history'));
      assert.match(result.history, /1:nested-history/);assert.doesNotMatch(result.history, /nested-working|root-history/);
      assert.match(result.current, /1:nested-working/);assert.equal(result.show, 'nested-history\\n');
      assert(events.some(event => event.type === 'guarded_tool_start' && event.detail.includes('nested/file.txt')));
    } else if (scenario === 'events') {
      assert.equal(await client.prompt('tool'), 'answer DO_NOT_LOG');
      assert(events.some(event => event.type === 'message_end' && event.stopReason === 'toolUse' && event.hasText === false));
      assert(events.some(event => event.type === 'message_end' && event.stopReason === 'stop' && event.hasText));
      assert(events.some(event => event.type === 'tool_execution_start'));
      assert(events.some(event => event.type === 'tool_execution_end' && event.isError === false));
      assert(!JSON.stringify(events).includes('DO_NOT_LOG'));
      await assert.rejects(client.prompt('empty'), /No final assistant text/);
      await assert.rejects(client.prompt('error'), /Assistant turn error: quota exhausted \\[REDACTED CREDENTIAL\\]/);
      assert(events.some(event => event.type === 'operation_error' && event.op === 'prompt' && event.error.includes('quota exhausted')));
      assert(events.some(event => event.type === 'auto_retry_start' && event.attempt === 1));
      assert(events.some(event => event.type === 'auto_retry_end' && event.success === false));
      assert(!JSON.stringify(events).includes('x'.repeat(40)));
    } else if (scenario === 'abort' || scenario === 'close') {
      const pending = client.prompt('hold').then(() => { throw new Error('Aborted prompt unexpectedly succeeded'); }, error => error);
      await held.promise;
      if (scenario === 'abort') {
        await client.abort(); assert.match((await pending).message, /abort/i);
        assert.equal(await client.prompt('tool'), 'answer DO_NOT_LOG');
      } else {
        await client.close(); assert.match((await pending).message, /abort|clos|exit/i);
        await assert.rejects(client.prompt('tool'), /closed/);
      }
    } else if (scenario === 'timeout' || scenario === 'exit') {
      await assert.rejects(client.prompt(scenario), scenario === 'timeout' ? /timed out/ : /exited|disconnected/);
      assert(events.some(event => event.type === 'worker_termination' && event.observed === true), 'Rejection must follow owned process-tree termination');
      assert.equal(client.info, undefined);
      await assert.rejects(client.start());
    }
  }
} finally { await client.close(); }
console.log('fixture passed');
`;

for (const scenario of ['events', 'abort', 'close', 'timeout', 'exit', 'startup', 'nested-history']) {
  test(`native worker IPC: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-client-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const bun = Bun.which('bun');
    expect(bun).not.toBeNull();
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(root, 'preload.ts'), preload);
    writeFileSync(join(root, 'host.ts'), host);
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec ${quote(bun!)} --preload ${quote(join(root, 'preload.ts'))} "$@"\n`, { mode: 0o700 });
    const child = Bun.spawn([bun!, join(root, 'host.ts'), scenario], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe',
    });
    // A bounded watchdog must reap a broken child even when its IPC promise hangs.
    const timer = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(stdout).toContain('fixture passed');
    } finally { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}
