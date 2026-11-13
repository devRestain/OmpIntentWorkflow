import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, readlink, realpath, open, rename, chmod, symlink } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GitManager } from './git.ts';
import type { Check, Evidence, GitSnapshot, Workspace } from './contracts.ts';
import { sensitiveContent, sensitivePath } from './safety.ts';
import { z } from '@oh-my-pi/omptype/zod';

interface Component { prefix: string; source: string; baselineCommit: string; ref: string; snapshot: GitSnapshot; }
export interface WorkspaceSnapshot { kind: 'workspace'; source: string; selectedScopes: string[]; components: Component[]; }
interface Aggregate { version: 1; kind: 'baseline' | 'artifact' | 'candidate'; base?: string; commits: Record<string, string>; }
interface View { kind: 'task' | 'candidate' | 'delivery'; key: string; path: string; base: string; commit?: string; error?: string; children: Record<string, Workspace>; }
interface Manifest { version: 1; source: string; runId: string; snapshot: WorkspaceSnapshot; baseline: string; views: View[]; }
interface Input { path: string; mode: number; bytes: Buffer; link?: string; }

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const portable = (path: string) => path.split(sep).join('/');
const unavailable = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const excludedNames: Record<string, true> = Object.fromEntries(['.git', '.omp', '.omp-workflow', '.workflow', '.obsidian', 'node_modules', '.venv', 'venv', '__pycache__', '.cache'].map(name => [name, true]));
// Workspace-level owner stores are not implicit source scopes; source modules may use these names.
const ownerDataNames: Record<string, true> = { state: true, states: true, vault: true, vaults: true, runtime: true, runtimes: true };
const projectMarkers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'CMakeLists.txt'];
const commitSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const aggregateIdSchema = z.string().regex(/^workspace:[a-f0-9]{64}$/);
const gitSnapshotSchema = z.object({ head: commitSchema, branch: z.string(), indexHash: z.string(), trackedDiff: z.string(), cachedDiff: z.string(), untracked: z.record(z.string(), z.string()) });
const componentSchema = z.object({ prefix: z.string(), source: z.string(), baselineCommit: commitSchema, ref: z.string(), snapshot: gitSnapshotSchema });
const childSchema = z.object({ path: z.string(), branch: z.string(), baseCommit: commitSchema });
const manifestSchema = z.object({
  version: z.literal(1), source: z.string(), runId: z.string(), baseline: aggregateIdSchema,
  snapshot: z.object({ kind: z.literal('workspace'), source: z.string(), selectedScopes: z.array(z.string()), components: z.array(componentSchema).min(1) }),
  views: z.array(z.object({ kind: z.enum(['task', 'candidate', 'delivery']), key: z.string(), path: z.string(), base: aggregateIdSchema, commit: aggregateIdSchema.optional(), error: z.string().optional(), children: z.record(z.string(), childSchema) })),
});
const aggregateSchema = z.object({ version: z.literal(1), kind: z.enum(['baseline', 'artifact', 'candidate']), base: aggregateIdSchema.optional(), commits: z.record(z.string(), commitSchema) });
const acceptedSchema = z.object({ head: aggregateIdSchema });
const selectionSchema = z.object({ repositories: z.array(z.string()), scopes: z.array(z.string()) });

/** A single accepted manifest coordinates independent real Git owners, never their user branches. */
export class WorkspaceManager {
  readonly repo: string;
  readonly root: string;
  readonly runId: string;
  private readonly directory: string;
  private readonly assemblies: string;
  private readonly seed: string;
  private readonly manifestPath: string;
  private readonly acceptedPath: string;
  private manifest?: Manifest;
  private managers = new Map<string, GitManager>();
  private objects = new Map<string, Aggregate>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialization?: Promise<{ ref: string; head: string; snapshot: WorkspaceSnapshot }>;

  constructor(repo: string, root: string, runId: string, private readonly writePaths: string[], private readonly readPaths: string[] = []) {
    this.repo = resolve(repo); this.root = resolve(root); this.runId = runId;
    if (inside(this.repo, this.root)) throw new Error('Non-Git workspace state must be outside the source root');
    this.directory = resolve(this.root, 'workspace'); this.assemblies = resolve(this.directory, 'views');
    this.seed = resolve(this.directory, 'loose-source'); this.manifestPath = resolve(this.directory, 'manifest.json');
    this.acceptedPath = resolve(this.directory, 'accepted.sqlite');
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => undefined); return next;
  }
  private environment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'OMP Workflow', GIT_AUTHOR_EMAIL: 'omp-workflow@localhost', GIT_COMMITTER_NAME: 'OMP Workflow', GIT_COMMITTER_EMAIL: 'omp-workflow@localhost' };
  }
  private async git(cwd: string, args: string[], input?: string, allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      cwd, env: this.environment(), stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 && !allowFailure) throw new Error(`Workspace Git ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    return { code, stdout, stderr };
  }
  private async ownedDirectory(path: string): Promise<void> {
    if (!inside(this.root, path)) throw new Error(`Run metadata directory escapes ownership: ${path}`);
    let current = this.root;
    for (const part of relative(this.root, path).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Run metadata directory is not a private real directory: ${current}`);
      } catch (error) { if (!unavailable(error)) throw error; }
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  private async durableWrite(path: string, contents: string | Buffer): Promise<void> {
    await this.ownedDirectory(dirname(path));
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); const parent = await open(dirname(path), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  private async save(): Promise<void> { await this.durableWrite(this.manifestPath, JSON.stringify(this.manifest, null, 2)); }
  private blocked(path: string): boolean {
    const parts = path.split('/');
    return ownerDataNames[parts[0]!.toLowerCase()] === true || parts.some(part => excludedNames[part.toLowerCase()] === true || sensitivePath(part));
  }
  private prefix(path: string): string {
    if (isAbsolute(path) || path.includes('\0')) throw new Error(`Unsupported approved workspace path: ${path}`);
    let value = path.replace(/^\.\//, '').split(/[?*[{]/, 1)[0]!.replace(/\/+$/, '');
    if (value === '.') value = '';
    if (value.split('/').some(part => part === '..' || part === '.git') || this.blocked(value)) throw new Error(`Approved path enters private, sensitive, or owner-data scope: ${path}`);
    return value;
  }
  private async exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (unavailable(error)) return false; throw error; } }
  private async ignored(path: string): Promise<boolean> {
    const result = await this.git(this.repo, [`--git-dir=${resolve(this.seed, '.git')}`, `--work-tree=${this.repo}`, 'check-ignore', '--no-index', '-z', '--stdin'], `${path}\0`, true);
    if (result.code !== 0 && result.code !== 1) throw new Error(`Cannot resolve workspace ignore rules: ${result.stderr}`);
    return result.code === 0;
  }
  private async isVault(path: string): Promise<boolean> {
    return (await readdir(path)).some(name => /^\.obsidian(?:-|$)/.test(name));
  }
  private async temporaryScopes(): Promise<string[]> {
    const scopes: string[] = [];
    for (const approved of [...this.writePaths, ...this.readPaths]) {
      const path = this.prefix(approved);
      if (/^(?:tmp|temp)$/i.test(path.split('/')[0]!)) scopes.push(await this.looseScope(path));
    }
    return scopes;
  }
  private async discover(): Promise<string[]> {
    const found: string[] = [];
    const temporaryScopes = await this.temporaryScopes();
    const walk = async (path: string): Promise<void> => {
      const entries = await readdir(resolve(this.repo, path), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (/^(?:tmp|temp)$/i.test(name.split('/')[0]!)
          && !temporaryScopes.some(scope => name === scope || name.startsWith(`${scope}/`) || scope.startsWith(`${name}/`))) continue;
        if (this.blocked(name) || await this.ignored(name) || await this.isVault(resolve(this.repo, name))) continue;
        const metadata = resolve(this.repo, name, '.git');
        if (await this.exists(metadata)) {
          if ((await lstat(metadata)).isSymbolicLink()) throw new Error(`Repository metadata symlinks are unsupported: ${name}`);
          found.push(name);
        } else await walk(name);
      }
    };
    await walk(''); return found;
  }
  private owner(path: string, repositories: string[]): string | undefined {
    return repositories.find(prefix => path === prefix || path.startsWith(`${prefix}/`));
  }
  private async looseScope(path: string): Promise<string> {
    let directory = resolve(this.repo, path);
    while (!await this.exists(directory)) directory = dirname(directory);
    if (!(await lstat(directory)).isDirectory()) directory = dirname(directory);
    const nearest = directory;
    if (/^(?:tmp|temp)$/i.test(path.split('/')[0]!)) {
      const temporaryRoot = resolve(this.repo, path.split('/')[0]!);
      return nearest === temporaryRoot || nearest === this.repo
        ? (path.split('/').length > 2 ? portable(dirname(path)) : path)
        : portable(relative(this.repo, nearest));
    }
    while (inside(this.repo, directory)) {
      if ((await Promise.all(projectMarkers.map(marker => this.exists(resolve(directory, marker))))).some(Boolean)) {
        return directory === this.repo && path ? path.split('/')[0]! : portable(relative(this.repo, directory));
      }
      if (directory === this.repo) break;
      directory = dirname(directory);
    }
    return nearest === this.repo && path ? path.split('/')[0]! : portable(relative(this.repo, nearest));
  }
  private async selection(repositories: string[]): Promise<string[]> {
    const scopes = new Set<string>();
    for (const approved of [...this.writePaths, ...this.readPaths]) {
      const path = this.prefix(approved);
      if (this.owner(path, repositories)) continue;
      if (path && await this.ignored(path)) throw new Error(`Approved path is ignored and cannot be implicitly snapshotted: ${approved}`);
      scopes.add(await this.looseScope(path));
    }
    return [...scopes].sort().filter((path, index, all) => !all.some((ancestor, other) => other !== index && (ancestor === '' || path.startsWith(`${ancestor}/`))));
  }
  private async looseInputs(scopes: string[], repositories: string[]): Promise<Input[]> {
    const files = new Map<string, Input>();
    const temporaryScopes = await this.temporaryScopes();
    const walk = async (path: string, selected: boolean): Promise<void> => {
      if (this.owner(path, repositories)) return;
      if (/^(?:tmp|temp)$/i.test(path.split('/')[0]!)
        && !temporaryScopes.some(scope => path === scope || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`))) return;
      if (path && (this.blocked(path) || await this.ignored(path))) {
        if (selected && sensitivePath(path)) throw new Error(`Sensitive selected source input requires explicit user handling: ${path}`);
        return;
      }
      const absolute = resolve(this.repo, path), stat = await lstat(absolute);
      if (path && !inside(this.repo, await realpath(dirname(absolute)))) throw new Error(`Source input escapes workspace: ${path}`);
      if (stat.isDirectory()) {
        if (path && await this.isVault(absolute)) throw new Error(`Obsidian vaults are owner data, not implementation input: ${path}`);
        for (const entry of (await readdir(absolute)).sort()) await walk(path ? `${path}/${entry}` : entry, selected);
        return;
      }
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute), destination = resolve(dirname(absolute), target), destinationPath = portable(relative(this.repo, destination));
        if (isAbsolute(target) || !inside(this.repo, destination) || this.blocked(destinationPath)) throw new Error(`Unsafe source symlink: ${path}`);
        if (await this.exists(destination) && !inside(this.repo, await realpath(destination))) throw new Error(`Source symlink escapes workspace: ${path}`);
        files.set(path, { path, mode: 0o777, bytes: Buffer.from(target), link: target });
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        if (sensitiveContent(bytes)) throw new Error(`Sensitive source content requires explicit user handling: ${path}`);
        files.set(path, { path, mode: stat.mode & 0o111 ? 0o755 : 0o644, bytes });
      } else throw new Error(`Unsupported workspace source input: ${path}`);
    };
    // Root guides, ignore files and build/configuration inputs remain visible without a readPaths replan.
    for (const entry of await readdir(this.repo, { withFileTypes: true })) if (!entry.isDirectory() && entry.name !== '.git') await walk(entry.name, false);
    for (const scope of scopes) if (!scope || await this.exists(resolve(this.repo, scope))) await walk(scope, true);
    for (const file of files.values()) if (file.link !== undefined) {
      const destination = portable(relative(this.repo, resolve(dirname(resolve(this.repo, file.path)), file.link)));
      const represented = files.has(destination) || repositories.some(prefix => destination === prefix || destination.startsWith(`${prefix}/`)) || [...files.keys()].some(path => path.startsWith(`${destination}/`));
      if (!represented) throw new Error(`Symlink dependency is outside selected source scopes: ${file.path} -> ${file.link}`);
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  private fingerprint(files: Input[]): string { return hash(JSON.stringify(files.map(file => [file.path, file.mode, hash(file.bytes)]))); }
  private async prepareSeed(): Promise<{ repositories: string[]; scopes: string[] }> {
    await this.ownedDirectory(this.seed);
    if (await this.exists(resolve(this.seed, '.git')) && (await lstat(resolve(this.seed, '.git'))).isSymbolicLink()) throw new Error('Private snapshot repository metadata is a symlink');
    if (!await this.exists(resolve(this.seed, '.git'))) await this.git(this.seed, ['init', '--quiet']);
    const selectionPath = resolve(this.directory, 'selection.json');
    try {
      const saved = selectionSchema.parse(JSON.parse(await readFile(selectionPath, 'utf8')));
      for (const path of [...saved.repositories, ...saved.scopes]) if (path && this.prefix(path) !== path) throw new Error('Saved workspace selection contains an unsupported source path');
      return saved;
    } catch (error) { if (!unavailable(error)) throw error; }
    const repositories = await this.discover(), scopes = await this.selection(repositories);
    const files = await this.looseInputs(scopes, repositories);
    if (this.fingerprint(files) !== this.fingerprint(await this.looseInputs(scopes, repositories))) throw new Error('Loose source changed during snapshot capture; retry after source writes stop');
    const preparedPath = resolve(this.directory, 'snapshot-inputs.json');
    const prepared = JSON.stringify({ repositories, scopes, fingerprint: this.fingerprint(files) });
    try { if (await readFile(preparedPath, 'utf8') !== prepared) throw new Error('Source scope changed during interrupted workspace initialization; start a new run to capture the new source'); }
    catch (error) { if (!unavailable(error)) throw error; await this.durableWrite(preparedPath, prepared); }
    if ((await this.git(this.seed, ['rev-parse', '--verify', 'HEAD'], undefined, true)).code !== 0) {
      await this.git(this.seed, ['commit', '--quiet', '--allow-empty', '-m', 'OMP private source owner']);
    }
    for (const file of files) {
      const path = resolve(this.seed, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (file.link !== undefined) {
        if (!await this.exists(path)) await symlink(file.link, path);
        else if (!(await lstat(path)).isSymbolicLink() || await readlink(path) !== file.link) throw new Error(`Interrupted loose snapshot differs at ${file.path}`);
      } else { await this.durableWrite(path, file.bytes); await chmod(path, file.mode); }
    }
    await this.durableWrite(selectionPath, JSON.stringify({ repositories, scopes }));
    return { repositories, scopes };
  }
  private manager(prefix: string): GitManager {
    const manager = this.managers.get(prefix); if (!manager) throw new Error(`Unknown workspace component: ${prefix}`); return manager;
  }
  private async store(value: Aggregate): Promise<string> {
    const text = JSON.stringify(value), id = `workspace:${hash(text)}`;
    await this.durableWrite(resolve(this.directory, 'objects', `${id.slice(10)}.json`), text); this.objects.set(id, value); return id;
  }
  private async object(id: string): Promise<Aggregate> {
    if (!/^workspace:[a-f0-9]{64}$/.test(id)) throw new Error(`Not an aggregate workspace identity: ${id}`);
    const cached = this.objects.get(id); if (cached) return cached;
    const text = await readFile(resolve(this.directory, 'objects', `${id.slice(10)}.json`), 'utf8');
    if (`workspace:${hash(text)}` !== id) throw new Error(`Workspace manifest identity changed: ${id}`);
    const value = aggregateSchema.parse(JSON.parse(text));
    const prefixes = this.manifest!.snapshot.components.map(component => component.prefix);
    if (value.version !== 1 || JSON.stringify(Object.keys(value.commits)) !== JSON.stringify(prefixes)
      || Object.values(value.commits).some(commit => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))) throw new Error(`Malformed aggregate workspace object: ${id}`);
    this.objects.set(id, value); return value;
  }

  initialize(): Promise<{ ref: string; head: string; snapshot: WorkspaceSnapshot }> {
    if (this.initialization) return this.initialization.then(async info => ({ ...info, head: await this.readHead() }));
    this.initialization = this.initializeOnce().catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }
  private async initializeOnce(): Promise<{ ref: string; head: string; snapshot: WorkspaceSnapshot }> {
    const source = await realpath(this.repo), state = await realpath(this.root).catch(async error => { if (!unavailable(error)) throw error; await mkdir(this.root, { recursive: true, mode: 0o700 }); return realpath(this.root); });
    if (source !== this.repo || !inside(state, this.directory) || inside(source, state)) throw new Error('Workspace source/state must be canonical, separate real directories');
    if (await this.exists(resolve(this.repo, '.git'))) throw new Error('WorkspaceManager requires a non-Git source root; use GitManager for a repository root');
    await this.ownedDirectory(this.assemblies);
    try {
      const saved = manifestSchema.parse(JSON.parse(await readFile(this.manifestPath, 'utf8')));
      if (saved.source !== source || saved.snapshot.source !== source || saved.runId !== this.runId) throw new Error('Workspace manifest belongs to a different source/run');
      const prefixes = saved.snapshot.components.map(component => component.prefix);
      if (prefixes[0] !== '' || new Set(prefixes).size !== prefixes.length) throw new Error('Workspace component identities are malformed');
      for (const component of saved.snapshot.components) {
        if (component.prefix && this.prefix(component.prefix) !== component.prefix
          || component.source !== (component.prefix ? resolve(this.repo, component.prefix) : this.seed)) throw new Error('Workspace component ownership changed');
      }
      for (const scope of saved.snapshot.selectedScopes) if (scope && this.prefix(scope) !== scope) throw new Error('Workspace source scope changed');
      this.manifest = saved;
    } catch (error) {
      if (!unavailable(error)) throw error;
      const selection = await this.prepareSeed();
      this.manifest = { version: 1, source, runId: this.runId, baseline: '', views: [], snapshot: { kind: 'workspace', source, selectedScopes: selection.scopes, components: [] } };
      for (const prefix of ['', ...selection.repositories]) {
        await this.ownedDirectory(resolve(this.directory, 'components', hash(prefix), 'git'));
        const manager = new GitManager(prefix ? resolve(this.repo, prefix) : this.seed, resolve(this.directory, 'components', hash(prefix)), `${this.runId}:${hash(prefix).slice(0, 12)}`, { worktreeRoot: this.assemblies, excludedPaths: prefix ? [] : selection.repositories });
        this.managers.set(prefix, manager); const info = await manager.initialize();
        this.manifest.snapshot.components.push({ prefix, source: manager.repo, baselineCommit: info.head, ref: info.ref, snapshot: info.snapshot });
      }
      this.manifest.baseline = await this.store({ version: 1, kind: 'baseline', commits: Object.fromEntries(this.manifest.snapshot.components.map(component => [component.prefix, component.baselineCommit])) });
      await this.save();
    }
    const prefixes = this.manifest.snapshot.components.filter(component => component.prefix).map(component => component.prefix);
    for (const component of this.manifest.snapshot.components) {
      await this.ownedDirectory(resolve(this.directory, 'components', hash(component.prefix), 'git'));
      if (!this.managers.has(component.prefix)) this.managers.set(component.prefix, new GitManager(component.source, resolve(this.directory, 'components', hash(component.prefix)), `${this.runId}:${hash(component.prefix).slice(0, 12)}`, { worktreeRoot: this.assemblies, excludedPaths: component.prefix ? [] : prefixes }));
      const info = await this.manager(component.prefix).initialize();
      if (info.ref !== component.ref) throw new Error(`Workspace component ref identity changed: ${component.prefix}`);
    }
    await this.object(this.manifest.baseline);
    for (const view of this.manifest.views) if (view.commit) await this.object(view.commit);
    const published = await this.exists(resolve(this.directory, 'published'));
    if (!await this.exists(this.acceptedPath) && published) throw new Error('Accepted workspace pointer disappeared; refusing baseline reset');
    const db = this.database(true);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS accepted (slot INTEGER PRIMARY KEY CHECK(slot=1), head TEXT NOT NULL)');
      db.transaction(() => {
        if (db.query('SELECT head FROM accepted WHERE slot=1').get()) return;
        if (published) throw new Error('Accepted workspace pointer disappeared; refusing baseline reset');
        db.query('INSERT INTO accepted(slot,head) VALUES(1,?)').run(this.manifest!.baseline);
      }).immediate();
    } finally { db.close(); }
    await this.durableWrite(resolve(this.directory, 'published'), this.runId);
    await this.ensureScope([...this.writePaths, ...this.readPaths]);
    return { ref: this.acceptedPath, head: await this.readHead(), snapshot: this.manifest.snapshot };
  }
  private database(create = false): Database {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { if (!lstatSync(`${this.acceptedPath}${suffix}`).isFile()) throw new Error('Accepted workspace database metadata is not a private regular file'); }
      catch (error) { if (!unavailable(error)) throw error; }
    }
    const db = new Database(this.acceptedPath, { create, strict: true });
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;'); return db;
  }
  private async readHead(): Promise<string> {
    const db = this.database();
    try { const value = acceptedSchema.parse(db.query('SELECT head FROM accepted WHERE slot=1').get()); await this.object(value.head); return value.head; }
    finally { db.close(); }
  }
  async head(): Promise<string> { return (await this.initialize()).head; }
  async ensureScope(paths: string[]): Promise<void> {
    if (!this.manifest) { await this.initialize(); return this.ensureScope(paths); }
    const repositories = this.manifest.snapshot.components.filter(component => component.prefix).map(component => component.prefix);
    for (const approved of paths) {
      const path = this.prefix(approved); if (this.owner(path, repositories)) continue;
      if (/^(?:tmp|temp)$/i.test(path.split('/')[0]!)
        && !this.manifest.snapshot.selectedScopes.some(scope => /^(?:tmp|temp)$/i.test(scope.split('/')[0]!) && (path === scope || path.startsWith(`${scope}/`)))) {
        throw new Error(`Approved temporary path ${approved} expands beyond frozen workspace source scopes; start a new run with that exact temporary subtree explicitly selected`);
      }
      if (this.manifest.snapshot.selectedScopes.some(scope => scope === '' || path === scope || path.startsWith(`${scope}/`))) continue;
      if (path && !path.includes('/')) {
        if (!await this.exists(resolve(this.repo, path)) || !(await lstat(resolve(this.repo, path))).isDirectory()) continue;
      }
      if (path && !await this.exists(resolve(this.repo, path))) {
        const scope = await this.looseScope(path);
        if (this.manifest.snapshot.selectedScopes.includes(scope)) continue;
      }
      throw new Error(`Approved path ${approved} expands beyond frozen workspace source scopes; start a new run with that source scope explicitly approved`);
    }
  }
  private viewPath(kind: View['kind'], key: string): string { return resolve(this.assemblies, `${kind}-${hash(key)}`); }
  private async validPath(view: View): Promise<void> {
    if (!inside(this.assemblies, view.path) || view.path === this.assemblies) throw new Error('Aggregate workspace path is outside run ownership');
    await this.ownedDirectory(dirname(view.path));
    if (!inside(await realpath(this.assemblies), await realpath(dirname(view.path)))) throw new Error('Aggregate workspace parent is a symlink escape');
    for (const component of this.manifest!.snapshot.components) {
      let ancestor = dirname(resolve(view.path, component.prefix));
      while (inside(view.path, ancestor)) {
        if (await this.exists(ancestor) && (await lstat(ancestor)).isSymbolicLink()) throw new Error(`Workspace mount parent is a symlink: ${ancestor}`);
        if (ancestor === view.path) break; ancestor = dirname(ancestor);
      }
    }
  }
  private async assemble(view: View, artifacts?: Aggregate[]): Promise<void> {
    await this.validPath(view); const base = await this.object(view.base);
    for (const component of this.manifest!.snapshot.components) {
      const prefix = component.prefix, manager = this.manager(prefix), path = resolve(view.path, prefix);
      let child: Workspace;
      if (view.kind === 'task') child = await manager.create(view.key, base.commits[prefix], path);
      else if (view.kind === 'candidate') {
        const prepared = await manager.candidate((artifacts ?? []).map(artifact => artifact.commits[prefix]!), base.commits[prefix], path);
        child = { path, branch: '', baseCommit: prepared.oldHead };
      } else { await manager.deliver(base.commits[prefix], path); child = { path, branch: '', baseCommit: base.commits[prefix]! }; }
      view.children[prefix] = child; await this.save();
    }
  }
  async create(taskId: string): Promise<Workspace> {
    await this.initialize(); return this.exclusive(async () => {
      let view = this.manifest!.views.find(view => view.kind === 'task' && view.key === taskId);
      if (!view) { view = { kind: 'task', key: taskId, path: this.viewPath('task', taskId), base: await this.head(), children: {} }; this.manifest!.views.push(view); await this.save(); }
      await this.assemble(view); return { path: view.path, branch: `workspace/${hash(taskId)}`, baseCommit: view.base };
    });
  }
  private async verify(view: View, expected?: string, clean = false): Promise<void> {
    await this.validPath(view); const object = expected ? await this.object(expected) : undefined;
    for (const component of this.manifest!.snapshot.components) {
      const path = resolve(view.path, component.prefix), verified = await this.manager(component.prefix).verifyWorkspace(path);
      if (object && verified.head !== object.commits[component.prefix]) throw new Error(`Workspace component HEAD changed: ${component.prefix || '(loose source)'}`);
      if (clean) await this.manager(component.prefix).checks(path, [], object?.commits[component.prefix]);
    }
  }
  async commit(workspace: Workspace, message: string): Promise<string> {
    await this.initialize(); return this.exclusive(async () => {
      const view = this.manifest!.views.find(view => view.kind === 'task' && view.path === resolve(workspace.path));
      if (!view || workspace.baseCommit !== view.base || workspace.branch !== `workspace/${hash(view.key)}`) throw new Error('Task metadata does not match its aggregate workspace');
      await this.verify(view); const commits: Record<string, string> = {};
      for (const component of this.manifest!.snapshot.components) commits[component.prefix] = await this.manager(component.prefix).commit(view.children[component.prefix]!, message);
      view.commit = await this.store({ version: 1, kind: 'artifact', base: view.base, commits }); await this.save();
      await this.verify(view, view.commit, true); return view.commit;
    });
  }
  async candidate(artifactIds: string[]): Promise<{ path: string; commit: string; oldHead: string }> {
    await this.initialize(); return this.exclusive(async () => {
      const ids = [...new Set(artifactIds)], artifacts = await Promise.all(ids.map(id => this.object(id)));
      if (artifacts.some(artifact => artifact.kind !== 'artifact')) throw new Error('Candidates accept task artifact manifests only');
      const oldHead = await this.head(), key = JSON.stringify([oldHead, ids]);
      let view = this.manifest!.views.find(view => view.kind === 'candidate' && view.key === key);
      if (!view) { view = { kind: 'candidate', key, path: this.viewPath('candidate', key), base: oldHead, children: {} }; this.manifest!.views.push(view); await this.save(); }
      if (view.error) throw new Error(`Aggregate candidate retained at ${view.path}: ${view.error}`);
      if (!view.commit) {
        try {
          await this.assemble(view, artifacts); const commits: Record<string, string> = {};
          for (const component of this.manifest!.snapshot.components) commits[component.prefix] = (await this.manager(component.prefix).verifyWorkspace(resolve(view.path, component.prefix))).head;
          view.commit = await this.store({ version: 1, kind: 'candidate', base: oldHead, commits }); await this.save();
        } catch (error) { view.error = error instanceof Error ? error.message : String(error); await this.save(); throw error; }
      }
      await this.verify(view, view.commit, true); return { path: view.path, commit: view.commit, oldHead };
    });
  }
  adoptSync(candidate: string, expectedOld: string): void {
    if (!this.manifest || !this.objects.has(candidate)) throw new Error('Initialize and prepare aggregate candidate before adoption');
    const view = this.manifest.views.find(view => view.kind === 'candidate' && view.commit === candidate && view.base === expectedOld && !view.error);
    if (!view) throw new Error('Adoption requires this run\'s exact aggregate candidate and old head');
    const db = this.database();
    try {
      db.transaction(() => {
        const current = acceptedSchema.parse(db.query('SELECT head FROM accepted WHERE slot=1').get()).head;
        if (current === candidate) return;
        if (current !== expectedOld) throw new Error(`Stale aggregate acceptance: expected ${expectedOld}, found ${current}`);
        if (db.query('UPDATE accepted SET head=? WHERE slot=1 AND head=?').run(candidate, expectedOld).changes !== 1) throw new Error('Aggregate acceptance compare-and-swap failed');
      }).immediate();
    } finally { db.close(); }
  }
  async adopt(candidate: string, expectedOld: string): Promise<void> { await this.initialize(); this.adoptSync(candidate, expectedOld); }
  async treeHash(id: string): Promise<string> {
    await this.initialize(); const value = await this.object(id), trees: [string, string][] = [];
    for (const component of this.manifest!.snapshot.components) trees.push([component.prefix, await this.manager(component.prefix).treeHash(value.commits[component.prefix]!)]);
    return hash(JSON.stringify(trees));
  }
  async checks(path: string, checks: Check[], id?: string): Promise<Evidence[]> {
    await this.initialize(); const view = this.manifest!.views.find(view => view.path === resolve(path));
    if (!view) throw new Error('Checks require an owned assembled workspace');
    const expected = id ?? view.commit ?? view.base; await this.verify(view, expected, true); const value = await this.object(expected), evidence: Evidence[] = [];
    for (const check of checks) {
      if (!Array.isArray(check.command) || !check.command.length || check.command.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Checks require a nonempty executable argv without NUL bytes');
      if (check.command[0] === 'git') {
        const explicit = check.command[1] === '-C';
        const target = explicit && typeof check.command[2] === 'string' ? portable(relative(view.path, resolve(view.path, check.command[2]))) : undefined;
        const components = explicit ? this.manifest!.snapshot.components.filter(component => component.prefix === target) : this.manifest!.snapshot.components;
        if (explicit && (!components.length || check.command.length < 4 || isAbsolute(check.command[2]!))) throw new Error('Explicit Git checks must name an exact selected component with a relative -C path');
        if (!explicit && (check.command.length !== 3 || check.command[1] !== 'diff' || check.command[2] !== '--check')) throw new Error('Root Git checks on aggregate workspaces require an explicit component cwd; only git diff --check has defined all-component semantics');
        for (const component of components) {
          const command = explicit ? ['git', ...check.command.slice(3)] : ['git', 'diff', '--check', `${component.baselineCommit}..${value.commits[component.prefix]}`, '--'];
          const rows = await this.manager(component.prefix).checks(resolve(path, component.prefix), [{ ...check, command }], value.commits[component.prefix]);
          evidence.push(...rows.map(row => ({ ...row, command: [...check.command], executedCommand: row.command, commit: expected })));
        }
      } else {
        const startedAt = new Date().toISOString(); let exitCode = 127, stdout = '', stderr = '';
        try { const child = Bun.spawn(check.command, { cwd: view.path, env: this.environment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }); [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
        catch (error) { stderr = error instanceof Error ? error.message : String(error); }
        evidence.push({ command: [...check.command], cwd: view.path, commit: expected, exitCode, stdout, stderr, startedAt, endedAt: new Date().toISOString() });
      }
      await this.verify(view, expected, true);
    }
    await this.durableWrite(resolve(this.directory, `checks-${randomUUID()}.json`), JSON.stringify(evidence, null, 2)); return evidence;
  }
  async deliver(): Promise<{ path: string; commit: string; repositories: { path: string; source: string; commit: string }[]; selectedScopes: string[] }> {
    await this.initialize(); return this.exclusive(async () => {
      const commit = await this.head(); let view = this.manifest!.views.find(view => view.kind === 'delivery' && view.base === commit);
      if (!view) { view = { kind: 'delivery', key: commit, path: this.viewPath('delivery', commit), base: commit, commit, children: {} }; this.manifest!.views.push(view); await this.save(); }
      await this.assemble(view); await this.verify(view, commit, true); const object = await this.object(commit);
      return { path: view.path, commit, repositories: this.manifest!.snapshot.components.map(component => ({ path: resolve(view.path, component.prefix), source: component.source, commit: object.commits[component.prefix]! })), selectedScopes: this.manifest!.snapshot.selectedScopes };
    });
  }
}
