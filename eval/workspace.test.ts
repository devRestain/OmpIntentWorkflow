import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceManager } from '../src/workspace.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith('GIT_')));
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, env: { ...env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' }, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(result.exitCode, 0, result.stderr.toString()); return result.stdout.toString().trim();
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-workspace-'))); roots.push(root);
  const source = join(root, 'source'), state = join(root, 'state'); mkdirSync(source); mkdirSync(state);
  return { root, source, state };
}
function repository(source: string, prefix: string) {
  const path = join(source, prefix); mkdirSync(path, { recursive: true }); git(path, 'init', '--quiet');
  file(join(path, 'base.txt'), `${prefix} baseline\n`); file(join(path, '.gitignore'), 'ignored/\n');
  git(path, 'add', '.'); git(path, 'commit', '--quiet', '-m', 'Fixture baseline'); return path;
}
function preserved(repo: string) {
  return { head: git(repo, 'rev-parse', 'HEAD'), branch: git(repo, 'symbolic-ref', 'HEAD'), index: readFileSync(join(repo, '.git', 'index')).toString('base64'), status: git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), files: ['base.txt', 'new.txt'].filter(name => existsSync(join(repo, name))).map(name => [name, readFileSync(join(repo, name), 'utf8')]) };
}

test('multi-owner artifact uses actual linked worktrees, includes dependencies, preserves original dirty checkout/index', async () => {
  const { source, state } = fixture(), core = repository(source, 'Core'), app = repository(source, 'Operations/App');
  file(join(core, 'base.txt'), 'staged content\n'); git(core, 'add', 'base.txt'); file(join(core, 'base.txt'), 'unstaged content\n'); file(join(core, 'new.txt'), 'untracked source\n');
  file(join(source, 'AGENTS.md'), 'Root guide retained\n'); file(join(source, 'loose.txt'), 'loose baseline\n');
  file(join(source, 'State', 'owner.json'), 'must stay private'); file(join(source, 'Vault', 'document.md'), 'must stay private'); file(join(source, 'Runtime', 'live.json'), 'must stay private');
  file(join(source, '.env'), 'PRIVATE_VALUE=do-not-copy'); file(join(source, '.gitignore'), 'ignored/\n'); file(join(source, 'ignored', 'hidden.txt'), 'ignored source');
  const before = [preserved(core), preserved(app)];
  const manager = new WorkspaceManager(source, state, 'multi', ['Operations/App/base.txt', 'loose.txt']);
  const initialized = await manager.initialize(); assert.equal(initialized.snapshot.kind, 'workspace');
  assert.deepEqual(initialized.snapshot.components.map(component => component.prefix), ['', 'Core', 'Operations/App']);
  assert.deepEqual(initialized.snapshot.selectedScopes, ['loose.txt']);
  const workspace = await manager.create('cross-owner');
  assert.equal(readFileSync(join(workspace.path, 'Core/base.txt'), 'utf8'), 'unstaged content\n');
  assert.equal(readFileSync(join(workspace.path, 'Core/new.txt'), 'utf8'), 'untracked source\n');
  assert.equal(readFileSync(join(workspace.path, 'AGENTS.md'), 'utf8'), 'Root guide retained\n');
  for (const excluded of ['State', 'Vault', 'Runtime', '.env', 'ignored']) assert.equal(existsSync(join(workspace.path, excluded)), false);
  for (const [prefix, original] of [['Core', core], ['Operations/App', app]]) {
    const nested = join(workspace.path, prefix!);
    assert.equal(realpathSync(git(nested, 'rev-parse', '--path-format=absolute', '--git-common-dir')), realpathSync(join(original!, '.git')));
    assert.equal(realpathSync(git(nested, 'rev-parse', '--show-toplevel')), nested);
    assert.equal(readFileSync(join(nested, '.git'), 'utf8').startsWith('gitdir: '), true);
  }
  file(join(workspace.path, 'Core/result.ts'), 'export const core = true;\n');
  file(join(workspace.path, 'Operations/App/result.ts'), 'export const app = true;\n');
  file(join(workspace.path, 'loose.txt'), 'loose implemented\n');
  const artifact = await manager.commit(workspace, 'Implement across owners'), candidate = await manager.candidate([artifact]);
  const evidence = await manager.checks(candidate.path, [{ command: [process.execPath, '-e', "const fs=require('node:fs');if(!fs.existsSync('Core/result.ts')||!fs.existsSync('Operations/App/result.ts')||fs.readFileSync('loose.txt','utf8')!=='loose implemented\\n')process.exit(1)"], description: 'Assembled-root integration' }], candidate.commit);
  assert.equal(evidence[0]!.exitCode, 0); assert.equal(evidence[0]!.cwd, candidate.path); assert.equal(evidence[0]!.commit, candidate.commit);
  manager.adoptSync(candidate.commit, candidate.oldHead); assert.equal(await manager.head(), candidate.commit);
  const delivery = await manager.deliver(); assert.equal(delivery.repositories.length, 3);
  assert.equal(readFileSync(join(delivery.path, 'Operations/App/result.ts'), 'utf8'), 'export const app = true;\n');
  for (const component of delivery.repositories) assert.equal(git(component.path, 'rev-parse', 'HEAD'), component.commit);
  assert.deepEqual([preserved(core), preserved(app)], before); assert.equal(existsSync(join(source, '.git')), false); assert.equal(readFileSync(join(source, 'loose.txt'), 'utf8'), 'loose baseline\n');
});

test('non-Git-only source snapshots loose source scope without owner data or an enclosing source repository', async () => {
  const { source, state } = fixture();
  file(join(source, 'package.json'), '{"name":"fixture","private":true}\n'); file(join(source, 'src/a.ts'), 'export const a = 1;\n'); file(join(source, 'src/dependency.ts'), 'export const dependency = true;\n');
  file(join(source, 'State/database'), 'owner bytes'); file(join(source, 'unrelated/data'), 'unrelated bytes');
  const manager = new WorkspaceManager(source, state, 'loose', ['src/a.ts']); const setup = await manager.initialize(), workspace = await manager.create('edit');
  assert.deepEqual(setup.snapshot.selectedScopes, ['src']); assert.equal(existsSync(join(workspace.path, 'src/dependency.ts')), true); assert.equal(existsSync(join(workspace.path, 'unrelated')), false);
  file(join(workspace.path, 'src/a.ts'), 'export const a = 2;\n'); const artifact = await manager.commit(workspace, 'Update source'), candidate = await manager.candidate([artifact]);
  await manager.adopt(candidate.commit, candidate.oldHead); const delivered = await manager.deliver();
  assert.equal(readFileSync(join(delivered.path, 'src/a.ts'), 'utf8'), 'export const a = 2;\n'); assert.equal(readFileSync(join(source, 'src/a.ts'), 'utf8'), 'export const a = 1;\n'); assert.equal(existsSync(join(source, '.git')), false);
  assert.throws(() => new WorkspaceManager(source, join(source, '.workflow'), 'unsafe', ['src/a.ts']), /outside/);
});

test('concurrent independent artifacts compose, stale CAS refuses, and later artifacts reopen against accepted manifest', async () => {
  const { source, state } = fixture(); repository(source, 'A'); repository(source, 'B'); file(join(source, 'loose.txt'), 'baseline\n');
  const paths = ['A/first.txt', 'B/second.txt', 'loose.txt'], manager = new WorkspaceManager(source, state, 'compose', paths);
  const setup = await manager.initialize(), [first, second] = await Promise.all([manager.create('first'), manager.create('second')]);
  file(join(first.path, 'A/first.txt'), 'first\n'); file(join(second.path, 'B/second.txt'), 'second\n');
  const [one, two] = await Promise.all([manager.commit(first, 'First artifact'), manager.commit(second, 'Second artifact')]);
  const firstCandidate = await manager.candidate([one]), stale = await manager.candidate([two]);
  manager.adoptSync(firstCandidate.commit, setup.head); assert.throws(() => manager.adoptSync(stale.commit, setup.head), /Stale/);
  const composed = await manager.candidate([two]); manager.adoptSync(composed.commit, composed.oldHead);
  const restarted = new WorkspaceManager(source, state, 'compose', paths); assert.equal((await restarted.initialize()).head, composed.commit);
  restarted.adoptSync(composed.commit, composed.oldHead); // Idempotent receipt reconciliation.
  const third = await restarted.create('third'); assert.equal(third.baseCommit, composed.commit);
  assert.equal(readFileSync(join(third.path, 'A/first.txt'), 'utf8'), 'first\n'); assert.equal(readFileSync(join(third.path, 'B/second.txt'), 'utf8'), 'second\n');
  file(join(third.path, 'loose.txt'), 'third\n'); const three = await restarted.commit(third, 'Third artifact'), last = await restarted.candidate([three]); restarted.adoptSync(last.commit, last.oldHead);
  const delivered = await restarted.deliver(); assert.equal(readFileSync(join(delivered.path, 'loose.txt'), 'utf8'), 'third\n');
  assert.equal((await restarted.treeHash(last.commit)).length, 64); assert.equal(await restarted.treeHash(last.commit), await manager.treeHash(last.commit));
},30_000);

test('root git diff --check covers committed changes in every owner and records exact per-owner command', async () => {
  const { source, state } = fixture(); repository(source, 'A'); repository(source, 'B');
  const manager = new WorkspaceManager(source, state, 'checks', ['B/whitespace.txt']); await manager.initialize(); const workspace = await manager.create('bad-whitespace');
  file(join(workspace.path, 'B/whitespace.txt'), 'trailing space \n'); const artifact = await manager.commit(workspace, 'Whitespace'), candidate = await manager.candidate([artifact]);
  const evidence = await manager.checks(candidate.path, [{ command: ['git', 'diff', '--check'], description: 'Approved whitespace check' }], candidate.commit);
  assert.equal(evidence.length, 3); assert(evidence.every(row => row.commit === candidate.commit));
  assert(evidence.find(row => row.cwd === join(candidate.path, 'B'))!.exitCode !== 0); assert(evidence.some(row => row.stdout.includes('trailing whitespace')));
  await assert.rejects(manager.checks(candidate.path, [{ command: ['git', 'status'], description: 'Ambiguous root Git scope' }]), /explicit component cwd/);
  assert(evidence.every(row => JSON.stringify(row.command) === JSON.stringify(['git', 'diff', '--check'])));
  assert(evidence.every(row => row.executedCommand?.[3]?.includes('..')));
  const explicitCommand = ['git', '-C', 'B', 'rev-parse', 'HEAD'];
  const explicit = await manager.checks(candidate.path, [{ command: explicitCommand, description: 'Explicit component identity' }], candidate.commit);
  assert.equal(explicit.length, 1); assert.equal(explicit[0]!.cwd, join(candidate.path, 'B')); assert.deepEqual(explicit[0]!.command, explicitCommand);
  await assert.rejects(manager.checks(candidate.path, [{ command: ['git', '-C', '../outside', 'status'], description: 'Escaping component cwd' }]), /exact selected component/);
},30_000);

test('reopen preserves frozen baseline and task branches instead of recapturing changed original files', async () => {
  const { source, state } = fixture(), repo = repository(source, 'A'); file(join(source, 'loose.txt'), 'frozen\n');
  const manager = new WorkspaceManager(source, state, 'restart', ['A/new.txt', 'loose.txt']); const setup = await manager.initialize(), original = await manager.create('resume');
  file(join(original.path, 'A/new.txt'), 'retained task\n'); file(join(source, 'loose.txt'), 'changed user source\n'); file(join(repo, 'base.txt'), 'changed source checkout\n');
  const reopened = new WorkspaceManager(source, state, 'restart', ['A/new.txt', 'loose.txt']); assert.equal((await reopened.initialize()).head, setup.head);
  const resumed = await reopened.create('resume'); assert.equal(resumed.path, original.path); assert.equal(readFileSync(join(resumed.path, 'A/new.txt'), 'utf8'), 'retained task\n');
  assert.equal(readFileSync(join(resumed.path, 'loose.txt'), 'utf8'), 'frozen\n');
  const artifact = await reopened.commit(resumed, 'Resume retained work'), candidate = await reopened.candidate([artifact]); reopened.adoptSync(candidate.commit, candidate.oldHead);
  assert.equal(readFileSync(join(source, 'loose.txt'), 'utf8'), 'changed user source\n'); assert.equal(readFileSync(join(repo, 'base.txt'), 'utf8'), 'changed source checkout\n');
});

test('new unrepresented existing source scope refuses explicitly while selected new files remain permitted', async () => {
  const { source, state } = fixture(); file(join(source, 'src/a.ts'), 'source\n'); file(join(source, 'other/dependency.ts'), 'not snapshotted\n');
  const manager = new WorkspaceManager(source, state, 'scope', ['src/a.ts']); await manager.initialize();
  await manager.ensureScope(['src/new.ts', 'new-root.txt']); await assert.rejects(manager.ensureScope(['other/dependency.ts']), /beyond frozen/);
  await assert.rejects(manager.ensureScope(['State/owner.json']), /owner-data/);
});

test('relative source symlinks are isolated; escaping links and worktree mount-parent replacement refuse', async () => {
  const { source, state, root } = fixture(); repository(source, 'Operations/App'); file(join(source, 'src/actual.ts'), 'safe\n'); symlinkSync('actual.ts', join(source, 'src/link.ts'));
  const manager = new WorkspaceManager(source, state, 'links', ['src/actual.ts', 'Operations/App/new.ts']); await manager.initialize(); const workspace = await manager.create('safe');
  assert.equal(readFileSync(join(workspace.path, 'src/link.ts'), 'utf8'), 'safe\n'); file(join(workspace.path, 'src/actual.ts'), 'isolated\n'); assert.equal(readFileSync(join(source, 'src/actual.ts'), 'utf8'), 'safe\n');
  const outside = join(root, 'outside'); mkdirSync(outside); file(join(outside, 'secret.txt'), 'outside\n'); symlinkSync(outside, join(workspace.path, 'escape'));
  await assert.rejects(manager.commit(workspace, 'Reject escaping output'), /symlink/i);
  rmSync(join(workspace.path, 'escape'));
  renameSync(join(workspace.path, 'Operations'), join(workspace.path, 'Moved'));
  symlinkSync(outside, join(workspace.path, 'Operations'));
  await assert.rejects(manager.commit(workspace, 'Reject mount parent'), /symlink/i);
  symlinkSync(outside, join(source, 'src/unsafe'));
  const unsafe = new WorkspaceManager(source, join(root, 'unsafe-state'), 'unsafe-links', ['src/actual.ts']); await assert.rejects(unsafe.initialize(), /symlink/i);
});

test('ignored repositories and owner vaults are not discovered, and sensitive selected content refuses', async () => {
  const { source, state, root } = fixture(); repository(source, 'Core'); repository(source, 'ignored/Hidden'); repository(source, 'State/Owner');
  file(join(source, '.gitignore'), 'ignored/\n'); file(join(source, 'Documents/.obsidian/config'), '{}'); repository(source, 'Documents/VaultRepo');
  const manager = new WorkspaceManager(source, state, 'selection', ['Core/base.txt']); const setup = await manager.initialize();
  assert.deepEqual(setup.snapshot.components.map(component => component.prefix), ['', 'Core']);
  file(join(source, 'src/private.ts'), '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n');
  const unsafe = new WorkspaceManager(source, join(root, 'sensitive-state'), 'sensitive', ['src/private.ts']); await assert.rejects(unsafe.initialize(), /Sensitive source content/);
});

test('explicit loose read scope is isolated and does not broaden approved writes or copy sibling evidence', async () => {
  const { source, state } = fixture(); repository(source, 'Core');
  file(join(source, 'Tmp/proof/input.json'), '{"evidence":"retained"}\n'); file(join(source, 'Tmp/unrelated/owner.json'), 'unrelated owner evidence\n');
  const writes = ['Core/base.txt'], reads = ['Tmp/proof/input.json'];
  const manager = new WorkspaceManager(source, state, 'read-scope', writes, reads); const setup = await manager.initialize(), workspace = await manager.create('read');
  assert.deepEqual(writes, ['Core/base.txt']); assert.deepEqual(setup.snapshot.selectedScopes, ['Tmp/proof']);
  assert.equal(readFileSync(join(workspace.path, 'Tmp/proof/input.json'), 'utf8'), '{"evidence":"retained"}\n'); assert.equal(existsSync(join(workspace.path, 'Tmp/unrelated')), false);
  file(join(workspace.path, 'Tmp/proof/input.json'), 'isolated result copy\n');
  assert.equal(readFileSync(join(source, 'Tmp/proof/input.json'), 'utf8'), '{"evidence":"retained"}\n');
});

test('two discovered source linked worktrees with a common Git owner get distinct immutable task branches', async () => {
  const { source, state } = fixture(), first = repository(source, 'A');
  git(first, 'worktree', 'add', '--detach', join(source, 'B'), 'HEAD');
  const manager = new WorkspaceManager(source, state, 'shared-owner', ['A/new.txt', 'B/new.txt']); await manager.initialize(); const workspace = await manager.create('both');
  assert.notEqual(git(join(workspace.path, 'A'), 'symbolic-ref', 'HEAD'), git(join(workspace.path, 'B'), 'symbolic-ref', 'HEAD'));
  file(join(workspace.path, 'A/new.txt'), 'A\n'); file(join(workspace.path, 'B/new.txt'), 'B\n');
  const artifact = await manager.commit(workspace, 'Distinct source views'), candidate = await manager.candidate([artifact]); manager.adoptSync(candidate.commit, candidate.oldHead);
  const delivery = await manager.deliver(); assert.equal(readFileSync(join(delivery.path, 'A/new.txt'), 'utf8'), 'A\n'); assert.equal(readFileSync(join(delivery.path, 'B/new.txt'), 'utf8'), 'B\n');
});

test('private metadata symlinks refuse before creating any outside repository', async () => {
  const { source, state, root } = fixture(); file(join(source, 'source.ts'), 'safe\n');
  const outside = join(root, 'outside-state'); mkdirSync(outside); symlinkSync(outside, join(state, 'workspace'));
  const manager = new WorkspaceManager(source, state, 'metadata-link', ['source.ts']);
  await assert.rejects(manager.initialize(), /private real directory/); assert.equal(existsSync(join(outside, 'loose-source/.git')), false); assert.equal(existsSync(join(source, '.git')), false);
});

test('owner-store exclusions apply at workspace boundary, not legitimate state/runtime source modules', async () => {
  const { source, state } = fixture();
  file(join(source, 'package.json'), '{"name":"source-boundary","private":true}\n');
  file(join(source, 'src/state/model.ts'), 'export const state = true;\n');
  file(join(source, 'src/runtime/adapter.ts'), 'export const runtime = true;\n');
  file(join(source, 'States/private.json'), 'owner state\n');
  repository(source, 'States/PrivateRepo');
  file(join(source, 'KnowledgeHub/.obsidian-mac/config.json'), '{}');
  repository(source, 'KnowledgeHub/PrivateRepo');
  const manager = new WorkspaceManager(source, state, 'source-boundary', ['src/state/model.ts', 'src/runtime/adapter.ts']);
  const setup = await manager.initialize(), workspace = await manager.create('boundary');
  assert.deepEqual(setup.snapshot.components.map(component => component.prefix), ['']);
  assert.equal(readFileSync(join(workspace.path, 'src/state/model.ts'), 'utf8'), 'export const state = true;\n');
  assert.equal(readFileSync(join(workspace.path, 'src/runtime/adapter.ts'), 'utf8'), 'export const runtime = true;\n');
  assert.equal(existsSync(join(workspace.path, 'States')), false); assert.equal(existsSync(join(workspace.path, 'KnowledgeHub')), false);
});

test('temporary fixture repositories stay out of discovery unless their bounded subtree is explicitly selected', async () => {
  const { source, state, root } = fixture();
  file(join(source, 'package.json'), '{"name":"workspace-context","private":true}\n');
  repository(source, 'Core'); repository(source, 'Operations/App');
  const unrelated = repository(source, 'Tmp/unrelated/Disposable');
  repository(source, 'Temp/unrelated/Disposable'); repository(source, 'Tmp/needed/Dependency');
  file(join(unrelated, '.env'), 'PRIVATE_FIXTURE=must-not-be-admitted\n');
  file(join(source, 'Tmp/evidence/input.json'), '{"proof":"selected"}\n');
  const ordinary = new WorkspaceManager(source, state, 'default-temp-boundary', ['Operations/App/base.txt']);
  const setup = await ordinary.initialize(), task = await ordinary.create('ordinary');
  assert.deepEqual(setup.snapshot.components.map(component => component.prefix), ['', 'Core', 'Operations/App']);
  assert.equal(existsSync(join(task.path, 'Tmp')), false); assert.equal(existsSync(join(task.path, 'Temp')), false);
  const selected = new WorkspaceManager(source, join(root, 'selected-state'), 'selected-temp-boundary', ['Operations/App/base.txt'], ['Tmp/evidence/input.json', 'Tmp/needed/Dependency/base.txt']);
  const scoped = await selected.initialize(), workspace = await selected.create('scoped');
  assert.deepEqual(scoped.snapshot.components.map(component => component.prefix), ['', 'Core', 'Operations/App', 'Tmp/needed/Dependency']);
  assert.deepEqual(scoped.snapshot.selectedScopes, ['Tmp/evidence']);
  assert.equal(readFileSync(join(workspace.path, 'Tmp/evidence/input.json'), 'utf8'), '{"proof":"selected"}\n');
  assert.equal(existsSync(join(workspace.path, 'Tmp/needed/Dependency/.git')), true);
  assert.equal(existsSync(join(workspace.path, 'Tmp/unrelated')), false); assert.equal(existsSync(join(workspace.path, 'Temp')), false);
});
