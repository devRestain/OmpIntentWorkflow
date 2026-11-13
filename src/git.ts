import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, lstat, readlink, realpath, rm, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Check, Evidence, GitSnapshot, Workspace } from './contracts.ts';
import { sensitivePath, sensitiveContent } from './safety.ts';

interface FileInput { path: string; mode: string; bytes: Buffer; hash: string; }
interface OwnedTree {
  path: string;
  kind: 'task' | 'candidate' | 'delivery';
  key: string;
  baseCommit: string;
  branch?: string;
  commit?: string;
  error?: string;
  removed?: boolean;
}
interface Manifest {
  version: 1;
  repo: string;
  commonDir: string;
  runId: string;
  ref: string;
  baseline: string;
  published?: boolean;
  snapshot: GitSnapshot;
  sourceFiles: Record<string, string>;
  trees: OwnedTree[];
}
interface CommandResult { code: number; stdout: string; stderr: string; }
export interface GitManagerOptions { worktreeRoot?: string; excludedPaths?: string[]; }

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const safeName = (value: string) => `${value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'run'}-${digest(value).slice(0, 12)}`;
const splitZero = (text: string) => text.split('\0').filter(Boolean);

/** Run-owned refs and linked worktrees; the user's checkout and index are read-only. */
export class GitManager {
  readonly repo: string;
  readonly root: string;
  readonly runId: string;
  private readonly directory: string;
  private readonly manifestPath: string;
  private manifest?: Manifest;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly worktreeRoot: string;
  private readonly excludedPaths: string[];

  constructor(repo: string, root: string, runId: string, options: GitManagerOptions = {}) {
    this.repo = resolve(repo);
    this.root = resolve(root);
    this.runId = runId;
    if (this.root === this.repo) throw new Error('Run state directory must not be the source repository root');
    this.directory = resolve(this.root, 'git');
    this.manifestPath = resolve(this.directory, 'manifest.json');
    this.worktreeRoot = resolve(options.worktreeRoot ?? resolve(this.directory, 'worktrees'));
    this.excludedPaths = options.excludedPaths ?? [];
    if (this.excludedPaths.some(path => !path || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.git'))) {
      throw new Error('Excluded workspace paths must be relative source paths');
    }
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private environment(index?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
    }
    // Honor the user's ignore configuration without allowing inherited Git directory/index redirection.
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'OMP Workflow', GIT_AUTHOR_EMAIL: 'omp-workflow@localhost',
      GIT_COMMITTER_NAME: 'OMP Workflow', GIT_COMMITTER_EMAIL: 'omp-workflow@localhost',
    });
    if (index) env.GIT_INDEX_FILE = index;
    return env;
  }

  private gitArguments(args: string[]): string[] {
    return ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'core.quotePath=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args];
  }

  private async git(cwd: string, args: string[], options: { index?: string; input?: Uint8Array; allowFailure?: boolean } = {}): Promise<CommandResult> {
    const child = Bun.spawn(this.gitArguments(args), {
      cwd, env: this.environment(options.index),
      stdin: options.input === undefined ? 'ignore' : new Blob([new Uint8Array(options.input)]), stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0 && !options.allowFailure) {
      throw new Error(`Git ${args[0]} failed (${code}) in ${cwd}: ${stderr.trim() || stdout.trim()}`);
    }
    return { code, stdout, stderr };
  }

  private async text(cwd: string, args: string[]): Promise<string> {
    return (await this.git(cwd, args)).stdout.trim();
  }

  private async durableWrite(path: string, contents: string | Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  }

  private async save(): Promise<void> {
    await this.durableWrite(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  private excluded(cwd: string, path: string): boolean {
    return path.split('/').some(part => part === '.omp' || part === '.omp-workflow')
      || this.excludedPaths.some(excluded => path === excluded || path.startsWith(`${excluded}/`))
      || (inside(cwd, this.root) && inside(this.root, resolve(cwd, path)));
  }

  private validatePath(path: string): void {
    if (!path || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.git')) {
      throw new Error(`Unsupported Git input path: ${JSON.stringify(path)}`);
    }
    if (sensitivePath(path)) throw new Error(`Sensitive source input requires explicit user handling: ${path}`);
  }

  private async inputs(cwd: string, head: string): Promise<{ files: FileInput[]; paths: string[]; untracked: Set<string> }> {
    const [tree, index, other] = await Promise.all([
      this.git(cwd, ['ls-tree', '-r', '-z', head]),
      this.git(cwd, ['ls-files', '--stage', '-z']),
      this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const paths = new Set<string>();
    for (const entry of splitZero(tree.stdout)) {
      const tab = entry.indexOf('\t');
      const mode = entry.slice(0, entry.indexOf(' '));
      const path = entry.slice(tab + 1);
      if (mode === '160000') throw new Error(`Submodule input is unsupported: ${path}`);
      paths.add(path);
    }
    for (const entry of splitZero(index.stdout)) {
      const tab = entry.indexOf('\t');
      const [mode, , stage] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (mode === '160000') throw new Error(`Submodule input is unsupported: ${path}`);
      if (stage !== '0') throw new Error(`Unmerged index input is unsupported: ${path}`);
      paths.add(path);
    }
    const untracked = new Set(splitZero(other.stdout));
    for (const path of untracked) paths.add(path);
    const files: FileInput[] = [];
    for (const path of [...paths].sort()) {
      if (this.excluded(cwd, path)) continue;
      this.validatePath(path);
      const absolute = resolve(cwd, path);
      let stat;
      try { stat = await lstat(absolute); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      let bytes: Buffer;
      if (!inside(cwd, await realpath(dirname(absolute)))) throw new Error(`Source input parent escapes workspace: ${path}`);
      let mode: string;
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        const destination = resolve(dirname(absolute), target);
        if (isAbsolute(target)) throw new Error(`Absolute source symlinks are unsupported: ${path}`);
        if (!inside(cwd, destination) || this.excluded(cwd, relative(cwd, destination))) {
          throw new Error(`Symlink escapes the source workspace or enters workflow state: ${path}`);
        }
        this.validatePath(relative(cwd, destination).split(sep).join('/'));
        try {
          if (!inside(cwd, await realpath(destination))) throw new Error(`Symlink escapes the source workspace: ${path}`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        bytes = Buffer.from(target);
        mode = '120000';
      } else if (stat.isFile()) {
        bytes = await readFile(absolute);
        mode = stat.mode & 0o111 ? '100755' : '100644';
      } else if (stat.isDirectory() && !untracked.has(path)) {
        // A tracked file may have been replaced by a directory of new inputs.
        continue;
      } else {
        throw new Error(`Unsupported source input (directory, nested repository, or special file): ${path}`);
      }
      if (sensitiveContent(bytes)) throw new Error(`Sensitive source content requires explicit user handling: ${path}`);
      files.push({ path, mode, bytes, hash: digest(bytes) });
    }
    return { files, paths: [...paths], untracked };
  }

  private async capture(): Promise<{ snapshot: GitSnapshot; files: FileInput[]; paths: string[]; index: Buffer }> {
    const head = await this.text(this.repo, ['rev-parse', '--verify', 'HEAD']);
    const input = await this.inputs(this.repo, head);
    const branchResult = await this.git(this.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    if (branchResult.code !== 0 && branchResult.code !== 1) throw new Error(branchResult.stderr);
    const indexPath = await this.text(this.repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    let index: Buffer;
    try { index = await readFile(indexPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; index = Buffer.alloc(0); }
    const staged = await this.git(this.repo, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--']);
    for (const path of splitZero(staged.stdout)) {
      if (this.excluded(this.repo, path)) continue;
      const blob = await this.git(this.repo, ['show', `:${path}`]);
      if (sensitiveContent(Buffer.from(blob.stdout))) throw new Error(`Sensitive staged source content requires explicit user handling: ${path}`);
    }
    const [trackedDiff, cachedDiff] = await Promise.all([
      this.git(this.repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--']),
      this.git(this.repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--']),
    ]);
    if (sensitiveContent(Buffer.from(trackedDiff.stdout)) || sensitiveContent(Buffer.from(cachedDiff.stdout))) {
      throw new Error('Sensitive staged or deleted source content requires explicit user handling before snapshotting');
    }
    const untracked: Record<string, string> = Object.create(null);
    for (const file of input.files) if (input.untracked.has(file.path)) untracked[file.path] = file.hash;
    return {
      snapshot: { head, branch: branchResult.stdout.trim(), indexHash: digest(index), trackedDiff: trackedDiff.stdout, cachedDiff: cachedDiff.stdout, untracked },
      files: input.files, paths: input.paths, index,
    };
  }

  private fingerprint(files: FileInput[]): Record<string, string> {
    return Object.fromEntries(files.map(file => [file.path, `${file.mode}:${file.hash}`]));
  }

  private async writeTree(cwd: string, head: string, files: FileInput[], paths: string[]): Promise<string> {
    const index = resolve(this.directory, `index-${randomUUID()}`);
    try {
      await this.git(cwd, ['read-tree', head], { index });
      const present = new Set(files.map(file => file.path));
      // Explicitly remove deleted files and workflow state, including already tracked state.
      for (const path of paths) {
        if (!present.has(path)) await this.git(cwd, ['update-index', '--force-remove', '--', path], { index });
      }
      for (const file of files) {
        const object = (await this.git(cwd, ['hash-object', '-w', '--stdin'], { input: file.bytes })).stdout.trim();
        await this.git(cwd, ['update-index', '--add', '--cacheinfo', file.mode, object, file.path], { index });
      }
      return (await this.git(cwd, ['write-tree'], { index })).stdout.trim();
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  async initialize(): Promise<{ ref: string; head: string; snapshot: GitSnapshot }> {
    return this.exclusive(async () => {
      if (!this.manifest) {
        const top = await realpath(await this.text(this.repo, ['rev-parse', '--show-toplevel']));
        if (top !== await realpath(this.repo)) throw new Error('GitManager requires the repository worktree root, not a subdirectory');
        const commonDir = await realpath(await this.text(this.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        const sparse = await this.git(this.repo, ['config', '--bool', 'core.sparseCheckout'], { allowFailure: true });
        if (sparse.stdout.trim() === 'true') throw new Error('Sparse checkouts are unsupported: missing files cannot be treated as source deletions');
        if (sparse.code !== 0 && sparse.code !== 1) throw new Error(sparse.stderr);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
          const saved = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
          if (saved.version !== 1 || saved.repo !== top || saved.commonDir !== commonDir || saved.runId !== this.runId) {
            throw new Error(`Git run manifest does not belong to this repository/run: ${this.manifestPath}`);
          }
          this.manifest = saved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const before = await this.capture();
          const tree = await this.writeTree(this.repo, before.snapshot.head, before.files, before.paths);
          const after = await this.capture();
          if (JSON.stringify(before.snapshot) !== JSON.stringify(after.snapshot)
            || JSON.stringify(this.fingerprint(before.files)) !== JSON.stringify(this.fingerprint(after.files))) {
            throw new Error('Source checkout changed while capturing the baseline; retry when source writes have stopped');
          }
          const oldTree = await this.text(this.repo, ['rev-parse', `${before.snapshot.head}^{tree}`]);
          const baseline = tree === oldTree ? before.snapshot.head
            : (await this.git(this.repo, ['commit-tree', tree, '-p', before.snapshot.head, '-m', 'OMP source snapshot'])).stdout.trim();
          await this.durableWrite(resolve(this.directory, 'source.index'), before.index);
          this.manifest = {
            version: 1, repo: top, commonDir, runId: this.runId,
            ref: `refs/omp/${safeName(this.runId)}/accepted`, baseline,
            snapshot: before.snapshot, sourceFiles: this.fingerprint(before.files), trees: [],
          };
          await this.save();
        }
      }
      const data = this.manifest;
      const current = await this.git(this.repo, ['rev-parse', '--verify', data.ref], { allowFailure: true });
      if (current.code !== 0) {
        if (data.published) throw new Error(`Accepted ref disappeared; refusing to recreate an earlier baseline: ${data.ref}`);
        await this.git(this.repo, ['update-ref', data.ref, data.baseline, '0'.repeat(data.baseline.length)]);
      }
      if (!data.published) { data.published = true; await this.save(); }
      await this.assertRefDetached();
      return { ref: data.ref, head: await this.text(this.repo, ['rev-parse', '--verify', data.ref]), snapshot: data.snapshot };
    });
  }

  async snapshot(): Promise<GitSnapshot> { return (await this.capture()).snapshot; }

  private async assertRefDetached(): Promise<void> {
    const list = await this.git(this.repo, ['worktree', 'list', '--porcelain', '-z']);
    if (splitZero(list.stdout).includes(`branch ${this.manifest!.ref}`)) {
      throw new Error(`Accepted ref must not be checked out: ${this.manifest!.ref}`);
    }
  }

  private async materialize(record: OwnedTree): Promise<void> {
    try {
      await lstat(record.path);
      const verified = await this.verifyWorkspace(record.path);
      if (record.branch && verified.branch !== record.branch) throw new Error(`Owned task branch changed at ${record.path}`);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record.removed) throw new Error(`Workspace was cleaned up and cannot be resumed: ${record.path}`);
    await mkdir(dirname(record.path), { recursive: true, mode: 0o700 });
    if (record.branch) {
      const branch = await this.git(this.repo, ['rev-parse', '--verify', `refs/heads/${record.branch}`], { allowFailure: true });
      if (branch.code === 0) {
        if (branch.stdout.trim() !== record.baseCommit) throw new Error(`Recovery branch moved without its workspace: ${record.branch}`);
        await this.git(this.repo, ['worktree', 'add', record.path, record.branch]);
      } else {
        await this.git(this.repo, ['worktree', 'add', '-b', record.branch, record.path, record.baseCommit]);
      }
    } else {
      await this.git(this.repo, ['worktree', 'add', '--detach', record.path, record.baseCommit]);
    }
    await this.verifyWorkspace(record.path);
  }

  async create(taskId: string, base?: string, targetPath?: string): Promise<Workspace> {
    await this.initialize();
    return this.exclusive(async () => {
      let record = this.manifest!.trees.find(tree => tree.kind === 'task' && tree.key === taskId);
      if (!record) {
        const baseCommit = base ?? await this.head();
        const name = safeName(taskId);
        record = { path: targetPath ? resolve(targetPath) : resolve(this.directory, 'worktrees', `task-${name}`), kind: 'task', key: taskId,
          branch: `omp/${safeName(this.runId)}/task/${name}`, baseCommit };
        this.manifest!.trees.push(record);
        await this.save();
      }
      if ((base && record.baseCommit !== base) || (targetPath && record.path !== resolve(targetPath))
        || !inside(this.worktreeRoot, record.path)) throw new Error('Task workspace base/path does not match its owned record');
      await this.materialize(record);
      return { path: record.path, branch: record.branch!, baseCommit: record.baseCommit };
    });
  }

  async verifyWorkspace(path: string): Promise<{ cwd: string; commonDir: string; head: string; branch: string }> {
    if (!this.manifest) await this.initialize();
    const cwd = await realpath(path);
    const record = this.manifest!.trees.find(tree => tree.path === resolve(path) && !tree.removed);
    if (!record || (await lstat(record.path)).isSymbolicLink()
      || !inside(await realpath(this.worktreeRoot), cwd)) {
      throw new Error(`Workspace is not owned by this run: ${path}`);
    }
    const top = await realpath(await this.text(cwd, ['rev-parse', '--show-toplevel']));
    const commonDir = await realpath(await this.text(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    if (top !== cwd || commonDir !== this.manifest!.commonDir) throw new Error(`Workspace Git identity changed: ${path}`);
    const branch = await this.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    if (branch.code !== 0 && branch.code !== 1) throw new Error(branch.stderr);
    const name = branch.stdout.trim();
    if ((record.branch && name !== record.branch) || (!record.branch && name !== '')) throw new Error(`Workspace checkout changed: ${path}`);
    return { cwd, commonDir, head: await this.text(cwd, ['rev-parse', '--verify', 'HEAD']), branch: name };
  }

  async commit(workspace: Workspace, message: string): Promise<string> {
    const verified = await this.verifyWorkspace(workspace.path);
    const record = this.manifest!.trees.find(tree => tree.path === resolve(workspace.path))!;
    if (record.kind !== 'task' || record.branch !== workspace.branch || record.baseCommit !== workspace.baseCommit) {
      throw new Error('Task workspace metadata does not match its run-owned branch/base');
    }
    const descendant = await this.git(verified.cwd, ['merge-base', '--is-ancestor', workspace.baseCommit, verified.head], { allowFailure: true });
    if (descendant.code !== 0) throw new Error(`Task branch no longer descends from its assigned base: ${workspace.path}`);
    const input = await this.inputs(verified.cwd, verified.head);
    const tree = await this.writeTree(verified.cwd, verified.head, input.files, input.paths);
    const after = await this.inputs(verified.cwd, verified.head);
    if (JSON.stringify(this.fingerprint(input.files)) !== JSON.stringify(this.fingerprint(after.files))) {
      throw new Error(`Task files changed during commit capture: ${workspace.path}`);
    }
    if (tree === await this.text(verified.cwd, ['rev-parse', `${verified.head}^{tree}`])) {
      await this.git(verified.cwd, ['read-tree', verified.head]);
      return verified.head;
    }
    const commit = (await this.git(verified.cwd, ['commit-tree', tree, '-p', workspace.baseCommit, '-m', message])).stdout.trim();
    await this.git(verified.cwd, ['update-ref', `refs/heads/${workspace.branch}`, commit, verified.head]);
    await this.git(verified.cwd, ['update-ref', `refs/omp/${safeName(this.runId)}/artifacts/${commit}`, commit]);
    // Only the run-owned worktree index is aligned; working files are never reset.
    await this.git(verified.cwd, ['read-tree', commit]);
    return commit;
  }

  async candidate(artifactCommits: string[], base?: string, targetPath?: string): Promise<{ path: string; commit: string; oldHead: string }> {
    await this.initialize();
    return this.exclusive(async () => {
      const commits: string[] = [];
      for (const artifact of artifactCommits) {
        const commit = await this.text(this.repo, ['rev-parse', '--verify', '--end-of-options', `${artifact}^{commit}`]);
        if (!commits.includes(commit)) commits.push(commit);
      }
      const oldHead = base ?? await this.head();
      const key = digest(JSON.stringify(targetPath ? [oldHead, commits, resolve(targetPath)] : [oldHead, commits]));
      let record = this.manifest!.trees.find(tree => tree.kind === 'candidate' && tree.key === key);
      if (!record) {
        record = { path: targetPath ? resolve(targetPath) : resolve(this.directory, 'worktrees', `candidate-${key}`), kind: 'candidate', key, baseCommit: oldHead };
        this.manifest!.trees.push(record);
        await this.save();
      }
      if ((targetPath && record.path !== resolve(targetPath)) || !inside(this.worktreeRoot, record.path)) throw new Error('Candidate workspace path does not match its owned record');
      await this.materialize(record);
      if (record.error) throw new Error(`Candidate retained for recovery at ${record.path}: ${record.error}`);
      if (record.commit) {
        if ((await this.verifyWorkspace(record.path)).head !== record.commit) throw new Error(`Candidate HEAD changed: ${record.path}`);
        await this.requireClean(record.path);
        return { path: record.path, commit: record.commit, oldHead: record.baseCommit };
      }
      try {
        await this.requireClean(record.path);
        for (const commit of commits) {
          const ancestor = await this.git(record.path, ['merge-base', '--is-ancestor', commit, 'HEAD'], { allowFailure: true });
          if (ancestor.code === 0) continue;
          if (ancestor.code !== 1) throw new Error(ancestor.stderr);
          const parents = (await this.text(record.path, ['rev-list', '--parents', '-n', '1', commit])).split(' ').slice(1);
          if (parents.length !== 1) throw new Error(`Artifact must be a single-parent commit: ${commit}`);
          const equivalent = await this.text(record.path, ['cherry', 'HEAD', commit, parents[0]!]);
          if (!equivalent || equivalent.split('\n').every(line => line.startsWith('- '))) continue;
          const result = await this.git(record.path, ['cherry-pick', '--no-gpg-sign', '--allow-empty', commit], { allowFailure: true });
          if (result.code !== 0) {
            const log = resolve(this.directory, `candidate-${key}.log`);
            await this.durableWrite(log, JSON.stringify({ command: ['git', 'cherry-pick', '--no-gpg-sign', '--allow-empty', commit], cwd: record.path, ...result }, null, 2));
            throw new Error(`Cherry-pick failed (${result.code}); candidate preserved at ${record.path}; log: ${log}`);
          }
        }
        record.commit = await this.text(record.path, ['rev-parse', 'HEAD']);
        await this.requireClean(record.path);
        await this.git(this.repo, ['update-ref', `refs/omp/${safeName(this.runId)}/candidates/${record.key}`, record.commit]);
        await this.save();
        return { path: record.path, commit: record.commit, oldHead };
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        await this.save();
        throw error;
      }
    });
  }

  private async requireClean(path: string): Promise<void> {
    const status = await this.git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
      ':(exclude,glob)**/.omp', ':(exclude,glob)**/.omp/**',
      ':(exclude,glob)**/.omp-workflow', ':(exclude,glob)**/.omp-workflow/**',
      ...this.excludedPaths.flatMap(excluded => [`:(exclude,literal)${excluded}`, `:(exclude,glob)${excluded}/**`])]);
    if (status.stdout) throw new Error(`Workspace has uncommitted changes and is retained for recovery: ${path}`);
  }

  async checks(path: string, checks: Check[], commit?: string): Promise<Evidence[]> {
    const verified = await this.verifyWorkspace(path);
    const expected = commit ? await this.text(path, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`]) : verified.head;
    if (verified.head !== expected) throw new Error(`Check workspace is not at requested commit ${expected}: ${path}`);
    await this.requireClean(path);
    const evidence: Evidence[] = [];
    for (const check of checks) {
      if (!Array.isArray(check.command) || !check.command.length || check.command.some(value => typeof value !== 'string' || value.includes('\0'))) {
        throw new Error('Checks require a nonempty executable argv without NUL bytes');
      }
      if ((await this.verifyWorkspace(path)).head !== expected) throw new Error(`Check workspace HEAD changed: ${path}`);
      const startedAt = new Date().toISOString();
      let exitCode: number;
      let stdout = '';
      let stderr = '';
      try {
        const child = Bun.spawn(check.command, { cwd: verified.cwd, env: this.environment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      } catch (error) {
        exitCode = 127;
        stderr = error instanceof Error ? error.message : String(error);
      }
      evidence.push({ command: [...check.command], cwd: verified.cwd, commit: expected, exitCode, stdout, stderr,
        startedAt, endedAt: new Date().toISOString() });
      const logPath = resolve(this.directory, `check-${randomUUID()}.json`);
      await this.durableWrite(logPath, JSON.stringify(evidence[evidence.length - 1], null, 2));
      if ((await this.verifyWorkspace(path)).head !== expected) throw new Error(`Check command changed HEAD; output is not evidence for ${expected}: ${path}`);
      await this.requireClean(path);
    }
    return evidence;
  }

  /** Short synchronous CAS for the controller's durable acceptance transaction. */
  adoptSync(candidate: string, expectedOld: string): void {
    const data = this.manifest;
    if (!data) throw new Error('Initialize GitManager before adoption');
    const record = data.trees.find(tree => tree.kind === 'candidate' && tree.commit === candidate && tree.baseCommit === expectedOld && !tree.error && !tree.removed);
    if (!record) throw new Error('Adoption must name this run\'s exact prepared candidate and expected old HEAD');
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(candidate) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expectedOld)) {
      throw new Error('Adoption requires full commit object IDs');
    }
    const run = (args: string[]) => {
      const result = Bun.spawnSync(this.gitArguments(args), { cwd: this.repo, env: this.environment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
      return result.stdout.toString().trim();
    };
    if (splitZero(run(['worktree', 'list', '--porcelain', '-z'])).includes(`branch ${data.ref}`)) throw new Error('Accepted ref is checked out');
    if (run(['rev-parse', '--verify', data.ref]) === candidate) return;
    run(['update-ref', data.ref, candidate, expectedOld]);
  }

  async adopt(candidate: string, expectedOld: string): Promise<void> {
    await this.initialize();
    this.adoptSync(candidate, expectedOld);
  }

  async head(): Promise<string> {
    if (!this.manifest) await this.initialize();
    return this.text(this.repo, ['rev-parse', '--verify', this.manifest!.ref]);
  }
  async treeHash(commit: string): Promise<string> {
    return this.text(this.repo, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]);
  }

  async deliver(base?: string, targetPath?: string): Promise<{ commit: string; path: string }> {
    await this.initialize();
    return this.exclusive(async () => {
      const commit = base ?? await this.head();
      let record = this.manifest!.trees.find(tree => tree.kind === 'delivery' && tree.baseCommit === commit && !tree.removed
        && (!targetPath || tree.path === resolve(targetPath)));
      if (!record) {
        record = { path: targetPath ? resolve(targetPath) : resolve(this.directory, 'worktrees', `delivery-${commit}-${randomUUID()}`), kind: 'delivery', key: commit, baseCommit: commit, commit };
        this.manifest!.trees.push(record);
        await this.save();
      }
      if ((targetPath && record.path !== resolve(targetPath)) || !inside(this.worktreeRoot, record.path)) throw new Error('Delivery workspace path does not match its owned record');
      await this.materialize(record);
      if ((await this.verifyWorkspace(record.path)).head !== commit) throw new Error(`Delivery workspace HEAD changed: ${record.path}`);
      await this.requireClean(record.path);
      return { commit, path: record.path };
    });
  }

  async cleanup(): Promise<void> {
    await this.initialize();
    await this.exclusive(async () => {
      for (const record of this.manifest!.trees) {
        // Delivery and failed candidates remain available as the result/recovery evidence.
        if (record.removed || record.kind === 'delivery' || record.error) continue;
        try {
          await this.verifyWorkspace(record.path);
          await this.requireClean(record.path);
          const ignored = await this.git(record.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
          if (ignored.stdout) continue;
          const removed = await this.git(this.repo, ['worktree', 'remove', record.path], { allowFailure: true });
          if (removed.code === 0) { record.removed = true; await this.save(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { record.removed = true; await this.save(); }
          // Dirty, moved, or otherwise unverified worktrees are intentionally retained.
        }
      }
    });
  }
}
