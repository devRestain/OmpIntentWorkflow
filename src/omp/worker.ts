import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, discoverAuthStorage, discoverContextFiles, discoverSkills, getAgentDir, ModelRegistry, SessionManager, Settings, z, type AgentSession, type ExtensionFactory, type CustomTool } from '@oh-my-pi/pi-coding-agent';
import type { PermitRequest, WorkerConfig } from '../contracts.ts';
import { Effort } from '@oh-my-pi/pi-catalog/effort';
import { sensitivePath, sensitiveContent, redactForModel } from '../safety.ts';
import { createHash } from 'node:crypto';
import { toolProgressDetail } from './progress.ts';

type Frame = { kind: string; id?: number; op?: string; value?: unknown; allowed?: boolean; reason?: string };
const parentPid = Number(process.env.OMP_WORKFLOW_PARENT_PID);
let lastHeartbeat = Date.now();
let terminating = false;
let config: WorkerConfig;
let root = '';
let owned: string[] = [];
const skillCatalog=new Map<string,{filePath:string;baseDir:string;containRoot?:string}>();
let session: AgentSession | undefined;
let manager: SessionManager | undefined;
let registry: ModelRegistry | undefined;
let starting: Promise<unknown> | undefined;
let busy = false;
let activeOperation: Promise<void> | undefined;
let permitSequence = 0;
let activePromptAbort: AbortController | undefined;
const permits = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const commands = new Set<Bun.Subprocess>();
const sourcePath = fileURLToPath(import.meta.url);
const MAX_FILE = 1_048_576;
const MAX_OUTPUT = 48_000;

function send(frame: object) {
  if (!process.connected || !process.send) throw new Error('Parent IPC is disconnected');
  process.send(frame);
}
function emit(type: string, fields: Record<string, unknown> = {}) {
  if (process.connected) send({ kind: 'event', event: { type, ...fields, at: new Date().toISOString(), pid: process.pid } });
}
function errorText(error: unknown) {
  return redactForModel(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
function assertLive(signal?: AbortSignal) {
  if (terminating || !process.connected || process.ppid !== parentPid || Date.now() - lastHeartbeat > 5_000) throw new Error('Parent authority is no longer live');
  signal?.throwIfAborted();
  activePromptAbort?.signal.throwIfAborted();
}
function denyPermits(reason: string) {
  for (const pending of permits.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
  permits.clear();
}
function parentPermit(request: PermitRequest, signal?: AbortSignal) {
  assertLive(signal);
  const id = ++permitSequence;
  const { promise, resolve: accept, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { permits.delete(id); reject(new Error('Parent permit acknowledgement timed out')); }, 302_000);
  permits.set(id, { resolve: accept, reject, timer });
  const abort = () => {
    const entry = permits.get(id);
    if (entry) { clearTimeout(entry.timer); permits.delete(id); reject(new Error('Tool admission aborted')); }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try { send({ kind: 'permit', id, request }); }
  catch (error) { clearTimeout(timer); permits.delete(id); reject(error); }
  return promise.finally(() => signal?.removeEventListener('abort', abort));
}
function protectedPath(path: string) {
  const absolute = resolve(root, path);
  const sessionDirectory = resolve(config.sessionDir);
  if (absolute === sessionDirectory || absolute.startsWith(sessionDirectory + sep)) return true;
  return sensitivePath(path) || path.split(/[\\/]/).some(part => ['.git', '.omp', '.pi', '.claude', '.ssh', '.aws', '.npmrc', '.netrc', '.pypirc'].includes(part.toLowerCase()));
}
/** No model tool can introduce a symlink, hard link, device, or executable process. */
function scopedPath(input: unknown, write = false) {
  if (typeof input !== 'string' || !input || input.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw new Error('Expected a workspace filesystem path');
  const absolute = resolve(root, input);
  const local = relative(root, absolute);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || protectedPath(local)) throw new Error('Path is outside the permitted workspace or is protected metadata');
  if (write && (config.purpose !== 'implementation' || !owned.some(path => absolute === path || absolute.startsWith(path + sep)))) throw new Error('Path is not owned by this implementation task');
  let current = root;
  for (const part of local.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Symlink paths are not permitted');
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Only regular workspace files and directories are permitted');
      if (write && stat.isFile() && stat.nlink !== 1) throw new Error('Hard-linked files are not writable');
      const actual = realpathSync(current);
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Real path escaped workspace');
      if(protectedPath(relative(root,actual)))throw new Error('Canonical path is protected metadata or sensitive input');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
  return absolute;
}
function textFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Read requires a regular text file no larger than 1 MiB');
    const text = readFileSync(fd, 'utf8');
    if (text.includes('\0')) throw new Error('Binary files are not supported by the text tools');
    if(sensitiveContent(text))throw new Error('Sensitive key/token content cannot be sent to a model');
    return text;
  } finally { closeSync(fd); }
}
function putFile(path: string, text: string, signal?: AbortSignal) {
  if (Buffer.byteLength(text) > MAX_FILE) throw new Error('Write exceeds the 1 MiB text-file limit');
  assertLive(signal);
  scopedPath(path, true);
  // All filesystem validation and mutation below is synchronous: admission cannot interleave another model tool.
  mkdirSync(dirname(path), { recursive: true });
  scopedPath(path, true);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Write requires an unshared regular file');
    assertLive(signal);
    ftruncateSync(fd, 0);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function filesUnder(path: string, pattern = '**/*') {
  const stat = lstatSync(path);
  if (stat.isFile()) return [path];
  const files: string[] = [];
  const matcher = new Bun.Glob(pattern);
  let visited = 0;
  // Do not follow symlinks, enter Git metadata, or descend into credential/config directories.
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 20_000) throw new Error('Search exceeds 20,000 directory entries; narrow the path');
      const absolute = join(directory, entry.name);
      if (protectedPath(relative(root, absolute)) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && matcher.match(relative(path, absolute))) files.push(scopedPath(absolute));
    }
  };
  visit(path);
  return files;
}
function guardedTool(name: string, description: string, parameters: CustomTool['parameters'], run: (input: Record<string, unknown>, signal?: AbortSignal) => string | Promise<string>): CustomTool {
  return {
    name, label: name, description, parameters, loadMode: 'essential', approval: name === 'write' || name === 'edit' ? 'write' : 'read',
    async execute(toolCallId, raw, _onUpdate, _ctx, signal) {
      const input = raw as Record<string, unknown>;
      const normalized = { ...input };
      if ('path' in input) normalized.path = name==='read'&&typeof input.path==='string'&&input.path.startsWith('skill://')?input.path:scopedPath(input.path, name === 'edit' || name === 'write');
      const started = Date.now();
      emit('guarded_tool_start', { tool: name, toolCallId, detail: toolProgressDetail(name, input, root) });
      try {
        await parentPermit({ tool: name, input: normalized }, signal);
        assertLive(signal);
        const result = await run(normalized, signal);
        assertLive(signal);
        emit('guarded_tool_end', { tool: name, toolCallId, durationMs: Date.now() - started, success: true });
        return { content: [{ type: 'text', text: result.slice(0, MAX_OUTPUT) + (result.length > MAX_OUTPUT ? '\n[Output truncated; narrow the request.]' : '') }], details: {} };
      } catch (error) {
        emit('guarded_tool_end', { tool: name, toolCallId, durationMs: Date.now() - started, success: false });
        throw error;
      }
    },
  };
}
function skillResource(uri:string):string {
  const [name,...parts]=uri.slice('skill://'.length).split('/');
  const skill=skillCatalog.get(name!);if(!skill)throw new Error('Unknown native-discovered skill');
  const boundary=realpathSync(skill.containRoot??dirname(skill.filePath));
  const path=realpathSync(parts.length?resolve(dirname(skill.filePath),...parts):skill.filePath);
  if((path!==boundary&&!path.startsWith(boundary+sep))||sensitivePath(relative(boundary,path)))throw new Error('Skill resource is outside its allowed package or sensitive');
  return textFile(path);
}
function fileReadResult(text:string,input:Record<string,unknown>):string {
  const lines=text.split('\n'),start=Number(input.startLine??1),end=Number(input.endLine??Math.min(lines.length,start+399));
  if(end<start)throw new Error('endLine must be at least startLine');
  return `SHA256 ${createHash('sha256').update(text).digest('hex')}\n`+lines.slice(start-1,end).map((line,index)=>`${start+index}:${line}`).join('\n');
}
function owningRepository(path:string):string {
  let directory=dirname(path);
  while(directory===root||directory.startsWith(root+sep)){
    if(existsSync(join(directory,'.git')))return directory;
    if(directory===root)break;
    directory=dirname(directory);
  }
  throw new Error('No owning Git repository for this workspace file; use read for current non-Git bytes');
}
function toolSet() {
  const progressIntent = { i: z.string().max(80).optional().describe('Optional short user-facing activity label, e.g. Reading source contract. No reasoning, queries, content, or credentials.') };
  const tools = [
    guardedTool('read', 'Read CURRENT working-tree text bytes or a directory, or an exact native-discovered skill://name[/resource]. Workspace file reads include SHA256. This tool has no commit/revision parameter; use read_history for committed bytes. No credentials or arbitrary external files.', z.object({...progressIntent,path:z.string(),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional()}), input => {
      if(typeof input.path==='string'&&input.path.startsWith('skill://'))return skillResource(input.path);
      const path=scopedPath(input.path);
      if(lstatSync(path).isDirectory())return readdirSync(path,{withFileTypes:true}).filter(entry=>!entry.isSymbolicLink()&&!protectedPath(relative(root,join(path,entry.name)))).map(entry=>entry.name+(entry.isDirectory()?'/':'')).join('\n');
      return fileReadResult(textFile(path),input);
    }),
    guardedTool('read_history', 'Read committed file bytes at HEAD or a full exact Git commit SHA, including SHA256. Never reads uncommitted working-tree bytes; use read for those. No credentials or metadata paths.',z.object({...progressIntent,path:z.string(),commit:z.string().regex(/^(?:HEAD|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional()}),async input=>{
      const path=scopedPath(input.path),commit=String(input.commit);
      if(!/^(?:HEAD|[a-f0-9]{40}(?:[a-f0-9]{24})?)$/.test(commit))throw new Error('Historical reads require HEAD or an exact commit SHA');
      const repository=owningRepository(path);
      const child=Bun.spawn(['/usr/bin/git','--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','show','--no-ext-diff','--no-textconv',`${commit}:${relative(repository,path).split(sep).join('/')}`],{cwd:repository,stdout:'pipe',stderr:'pipe',env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
      const [code,output,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
      if(code!==0)throw new Error(`Historical file read failed: ${error}`);
      if(Buffer.byteLength(output)>MAX_FILE||sensitiveContent(output))throw new Error('Historical file is too large or sensitive');
      return fileReadResult(output,input);
    }),
    guardedTool('glob', 'Find workspace files matching a Bun glob, relative to path. Search is bounded; excludes protected metadata and symlinks.', z.object({ ...progressIntent, path: z.string().default('.'), pattern: z.string() }), input => filesUnder(scopedPath(input.path), String(input.pattern)).map(path => relative(root, path)).join('\n')),
    guardedTool('grep', 'Search workspace text files for a literal string (default), or a regular expression. Returns at most 200 matching lines.', z.object({ ...progressIntent, path: z.string().default('.'), pattern: z.string(), regex: z.boolean().default(false), caseSensitive: z.boolean().default(true) }), input => {
      const matches: string[] = [];
      const pattern = String(input.pattern);
      const expression = input.regex ? new RegExp(pattern, input.caseSensitive ? '' : 'i') : undefined;
      for (const path of filesUnder(scopedPath(input.path))) {
        let text: string;
        try { text = textFile(scopedPath(path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error; continue; }
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          const matched = expression ? expression.test(line) : input.caseSensitive ? line.includes(pattern) : line.toLowerCase().includes(pattern.toLowerCase());
          if (matched) matches.push(`${relative(root, path)}:${index + 1}:${line}`);
          if (matches.length === 200) return matches.join('\n') + '\n[200 matches; narrow the search.]';
        }
      }
      return matches.join('\n') || 'No matches';
    }),
  ];
  if (config.purpose === 'implementation') {
    tools.push(
      guardedTool('write', 'Create or replace an owned workspace UTF-8 file; content:null removes an owned regular file. Parent approval and writePaths are enforced. Cannot write Git/config/credential metadata or follow symlinks.', z.object({ ...progressIntent, path: z.string(), content: z.string().nullable() }), (input, signal) => {
        const path = scopedPath(input.path, true);
        if (input.content === null) {
          assertLive(signal);
          if (!lstatSync(path).isFile()) throw new Error('Deletion requires an owned regular file');
          unlinkSync(path);
          return `Deleted ${relative(root, path)}`;
        }
        putFile(path, String(input.content), signal);
        return `Wrote ${relative(root, path)}`;
      }),
      guardedTool('edit', 'Replace exactly one occurrence of oldText in an owned UTF-8 file. Read first. Use write to create files.', z.object({ ...progressIntent, path: z.string(), oldText: z.string().min(1), newText: z.string() }), (input, signal) => {
        const path = scopedPath(input.path, true);
        const before = textFile(path);
        const oldText = String(input.oldText);
        const position = before.indexOf(oldText);
        if (position < 0 || before.indexOf(oldText, position + 1) >= 0) throw new Error('oldText must match exactly once');
        putFile(path, before.slice(0, position) + String(input.newText) + before.slice(position + oldText.length), signal);
        return `Edited ${relative(root, path)}`;
      }),
      guardedTool('bash', 'Restricted argv inspection, NOT a shell or sandbox. Supports only ["pwd"], ["git","log"], ["git","show","HEAD:relative/path"], ["git","diff","--cached"]. No scripts, tests, installs, worktree filters, network, Git writes or user configuration changes. Controller runs verification separately.', z.object({ ...progressIntent, argv: z.array(z.string()).min(1).max(3) }), async (input, signal) => {
        const argv = input.argv as string[];
        if (argv.length === 1 && argv[0] === 'pwd') return root;
        let args: string[];
        let repository=root;
        if (argv.join('\0') === 'git\0log') args = ['log', '-10', '--oneline', '--no-decorate'];
        else if (argv.join('\0') === 'git\0diff\0--cached') args = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames'];
        else if (argv.length === 3 && argv[0] === 'git' && argv[1] === 'show' && argv[2]!.startsWith('HEAD:')) {
          const path = scopedPath(argv[2]!.slice(5));
          repository=owningRepository(path);
          args = ['show', '--no-ext-diff', '--no-textconv', `HEAD:${relative(repository, path).split(sep).join('/')}`];
        } else throw new Error('This argv is not an admitted read-only inspection. Use file tools for coding; the controller runs verification.');
        assertLive(signal);
        const git = Bun.which('git', { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin' });
        if (!git) throw new Error('Git executable not found');
        const child = Bun.spawn([git, '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'log.showSignature=false', ...args], {
          cwd: repository, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
          env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_REPLACE_OBJECTS: '1' },
        });
        commands.add(child);
        const kill = () => { try { child.kill('SIGKILL'); } catch { /* Already reaped. */ } };
        const timer = setTimeout(kill, 15_000);
        signal?.addEventListener('abort', kill, { once: true });
        activePromptAbort?.signal.addEventListener('abort', kill, { once: true });
        const readOutput = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_OUTPUT) { kill(); throw new Error('Inspection output exceeds 48 KiB; use scoped file tools'); }
            chunks.push(value);
          }
          return Buffer.concat(chunks).toString('utf8');
        };
        try {
          const [stdout, stderr, exitCode] = await Promise.all([readOutput(child.stdout as ReadableStream<Uint8Array>), readOutput(child.stderr as ReadableStream<Uint8Array>), child.exited]);
          if (exitCode !== 0) throw new Error(`Git inspection exited ${exitCode}: ${stderr}`);
          return stdout;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', kill);
          activePromptAbort?.signal.removeEventListener('abort', kill);
          kill();
          commands.delete(child);
        }
      }),
    );
  }
  return tools;
}

function selectedModel(selector: string) {
  if (!registry) throw new Error('Model registry is unavailable');
  const slash = selector.indexOf('/');
  const model = slash > 0 ? registry.find(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
  const matches = model ? [model] : registry.getAll().filter(candidate => candidate.id === selector || `${candidate.provider}/${candidate.id}` === selector);
  if (matches.length !== 1) throw new Error(`Model selector must identify exactly one installed model: ${selector}`);
  return matches[0]!;
}
async function startWorker(raw: unknown) {
  assertLive();
  config = raw as WorkerConfig;
  if (!config || !['planning', 'implementation', 'review'].includes(config.purpose) || !isAbsolute(config.cwd) || !isAbsolute(config.sessionDir) || typeof config.context !== 'string' || !config.model) throw new Error('Invalid worker configuration');
  root = realpathSync(config.cwd);
  owned = (config.writePaths ?? []).map(path => scopedPath(path));
  if (config.purpose === 'implementation' && owned.length === 0) throw new Error('Implementation requires explicit writePaths');
  mkdirSync(config.sessionDir, { recursive: true });
  if (config.sessionPath && !isAbsolute(config.sessionPath)) throw new Error('Resume requires an exact absolute session path');
  manager = config.sessionPath
    ? await SessionManager.open(config.sessionPath, config.sessionDir, undefined, { initialCwd: root, throwIfMissing: true, suppressBreadcrumb: true })
    : SessionManager.create(root, config.sessionDir);
  if (realpathSync(manager.getCwd()) !== root) throw new Error('Session cwd does not match this worker workspace');
  const discoveryRoot=config.instructionRoot?realpathSync(config.instructionRoot):root;
  const settings = await Settings.loadReadOnly({ cwd: discoveryRoot });
  const isolated = settings.overlay();
  const authStorage = await discoverAuthStorage(undefined, { settings: isolated, cwd: discoveryRoot });
  // 18.18.6's examples mention discoverModels, but its public export was removed; this is the SDK's actual construction path.
  registry = new ModelRegistry(authStorage, join(getAgentDir(), 'models.yml'), { settings: isolated });
  await registry.hydrateCredentialScopedModelCaches();
  const model = selectedModel(config.model);
  const [contextFiles, discovered] = await Promise.all([discoverContextFiles(discoveryRoot), discoverSkills(discoveryRoot)]);
  const skills=discovered.skills;
  for(const skill of skills)skillCatalog.set(skill.name,skill);
  const explicit=new Set([...config.context.matchAll(/(?:skill:\/\/|\/skill:)([A-Za-z0-9_.:-]+)/g)].map(match=>match[1]));
  const projectInstructions = contextFiles.map(file => `Project instructions (${file.path}):\n${file.content}`);
  const skillInstructions=skills.filter(skill=>explicit.has(skill.name)).map(skill=>`Explicitly selected skill ${skill.name}:\n${skillResource('skill://'+skill.name)}`);
  const systemPrompt = redactForModel([
    `You are the ${config.purpose} worker in a native OMP workflow.`,
    'The original user intent and constraints below are authoritative throughout the session, including after compaction.',
    config.context,
    ...projectInstructions,
    ...skillInstructions,
    'Discover matching skills from this native catalog and read only necessary bodies with read({path:\"skill://name\"}). Mandatory project instructions and explicit user-selected skills take precedence. Do not inject all skill bodies or discard global/user-selected skills.',
    JSON.stringify(skills.filter(skill=>!skill.hide||explicit.has(skill.name)).map(skill=>({name:skill.name,description:skill.description,uri:'skill://'+skill.name}))),
    `Workspace: ${root}. Owned write paths: ${JSON.stringify(config.writePaths ?? [])}.`,
    'Use only the supplied tools. They enforce a scoped filesystem policy, not an OS sandbox. Do not access credentials, sessions, external files, tool devices, MCP, eval, nested agents, or Git metadata. Parent approval is required for every tool call.',
    config.purpose === 'implementation' ? 'Implement the assigned change with read/read_history/grep/glob/edit/write. bash only provides the documented read-only argv inspections; verification is the controller’s job. Never invent tool results or generated-file fallbacks.' : 'Read-only analysis: read/read_history/grep/glob only. Never claim code was changed or checks were executed.',
    'Follow the current user request’s output format. JSON planning prompts are not worker-report prompts. Report observations, unmet requirements, and uncertainty truthfully.',
  ].join('\n\n'));
  let hooksInstalled = false;
  let providerStartedAt = 0;
  const hooks: ExtensionFactory = api => {
    hooksInstalled = true;
    api.on('before_agent_start', () => {
      assertLive();
      return { systemPrompt: [systemPrompt] };
    });
    api.on('context', () => { assertLive(); });
    api.on('before_provider_request', () => {
      assertLive();
      providerStartedAt = Date.now();
      emit('model_request', { model: session?.model ? `${session.model.provider}/${session.model.id}` : `${model.provider}/${model.id}` });
    });
    api.on('after_provider_response', () => { emit('model_response', { durationMs: Date.now() - providerStartedAt }); });
  };
  const tools = toolSet();
  const created = await createAgentSession({
    cwd: root, authStorage, modelRegistry: registry, model, thinkingLevel: {low:Effort.Low,medium:Effort.Medium,high:Effort.High,xhigh:Effort.XHigh}[config.thinking],
    settings: isolated, sessionManager: manager, systemPrompt, contextFiles, noContextFiles: true,
    skills, rules: [], promptTemplates: [], slashCommands: [],
    restrictToolNames: true, allowRestrictedCustomTools: true, toolNames: tools.map(tool => tool.name), customTools: tools,
    // Inline `extensions` are ignored by restricted sessions. Prepared factories really bind and preserve hooks.
    preloadedPreparedExtensions: [{ path: sourcePath, resolvedPath: sourcePath, factory: hooks, error: null }],
    disableExtensionDiscovery: true, enableMCP: false, enableIrc: false, enableLsp: false,
    skipPythonPreflight: true, requireYieldTool: false, spawns: '', autoApprove: true,
    outputSchemaMode: 'strict', cacheWarming: false, disableModelFallback: true, disableServerSideFallback: true,
    suppressAutoPrewalk: true, bindProcessState: false, hasUI: false, interactivePrompts: false, allowSessionModelFallback: false,
  });
  session = created.session;
  assertLive();
  if (!hooksInstalled || created.extensionsResult.errors.length) throw new Error('Restricted session guard hooks did not bind');
  const enabled = session.getEnabledToolNames();
  const metadata = session.getAllToolInfos();
  if (enabled.length !== tools.length || enabled.some(name => !tools.some(tool => tool.name === name))) throw new Error('SDK exposed an unexpected tool capability');
  for (const tool of tools) {
    if (!metadata.some(info => info.name === tool.name && info.sourceInfo.source === 'extension' && info.description === tool.description)) throw new Error(`Guarded SDK custom tool did not replace native tool: ${tool.name}`);
  }
  session.subscribe(event => {
    // Never serialize provider payloads, credential structures, transcript text, or tool outputs into evidence.
    const frame = event as unknown as Record<string, unknown>;
    const type = String(frame.type);
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      emit('message_end', { role: 'assistant', stopReason: event.message.stopReason, hasText: event.message.content.some(block => block.type === 'text' && block.text.trim().length > 0), ...(event.message.errorMessage ? { error: errorText(event.message.errorMessage) } : {}) });
    }
    if (event.type === 'auto_retry_start') {
      emit(type, { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: errorText(event.errorMessage) });
    } else if (event.type === 'auto_retry_end') {
      emit(type, { attempt: event.attempt, success: event.success, ...(event.finalError ? { error: errorText(event.finalError) } : {}) });
    } else if (['agent_start', 'agent_end', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_end', 'auto_compaction_start', 'auto_compaction_end'].includes(type)) {
      emit(type, { ...(typeof frame.toolName === 'string' ? { tool: frame.toolName } : {}), ...(typeof frame.toolCallId === 'string' ? { toolCallId: frame.toolCallId } : {}), ...(typeof frame.isError === 'boolean' ? { isError: frame.isError } : {}) });
    }
  });
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionPath = session.sessionFile;
  if (!sessionPath || !existsSync(sessionPath)) throw new Error('Native session was not persisted');
  if (config.sessionPath && resolve(sessionPath) !== resolve(config.sessionPath)) throw new Error('SDK relocated the session; exact-path resume refused');
  const actual = session.model;
  if (!actual) throw new Error('Native session has no selected model');
  emit('guard_ready', { tools: enabled, purpose: config.purpose, sessionPath, model: `${actual.provider}/${actual.id}` });
  return { sessionPath, pid: process.pid, model: `${actual.provider}/${actual.id}` };
}
async function operation(op: string, value: unknown) {
  if (op === 'start') {
    if (starting) throw new Error('Worker session has already started');
    starting = startWorker(value);
    return starting;
  }
  if (op === 'close') {
    terminating = true;
    activePromptAbort?.abort();
    denyPermits('Session is closing');
    for (const child of commands) child.kill('SIGKILL');
    if (session) { session.beginDispose(); await session.abort({ deliverQueuedMessages: false }); await activeOperation; await session.dispose(); }
    await manager?.flush();
    await manager?.close();
    return;
  }
  if (op === 'abort') {
    activePromptAbort?.abort();
    denyPermits('Session was aborted');
    for (const child of commands) child.kill('SIGKILL');
    await session?.abort({ deliverQueuedMessages: false, reason: 'Workflow parent abort' });
    await activeOperation;
    return;
  }
  if (!session) throw new Error('Session has not started');
  assertLive();
  if (op === 'steer') {
    if (typeof value !== 'string') throw new Error('Steering text must be a string');
    await session.steer(value);
    await manager?.flush();
    return;
  }
  if (busy) throw new Error('Session already has an active prompt or maintenance operation');
  busy = true;
  const settled = Promise.withResolvers<void>();
  activeOperation = settled.promise;
  try {
    if (op === 'prompt') {
      const request=typeof value==='string'?{text:value,images:undefined}:z.object({text:z.string(),images:z.array(z.object({type:z.literal('image'),data:z.string(),mimeType:z.string()}))}).parse(value);
      if(!request.text.trim()&&!request.images?.length)throw new Error('Prompt content is empty');
      activePromptAbort = new AbortController();
      const completion: { assistant?: Extract<AgentSession['messages'][number], { role: 'assistant' }> } = {};
      const unsubscribe = session.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'assistant') completion.assistant = event.message;
      });
      try {
        const accepted = await session.prompt(request.text, { images:request.images,runCommands: false, expandPromptTemplates: false, throwOnDrop: true });
        if (!accepted) throw new Error('Native session rejected the prompt');
        activePromptAbort.signal.throwIfAborted();
        const assistant = completion.assistant;
        if (!assistant) throw new Error('No final assistant message was observed');
        if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') throw new Error(`Assistant turn ${assistant.stopReason}${assistant.errorMessage ? `: ${errorText(assistant.errorMessage)}` : ''}`);
        const text = assistant.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (!text.trim()) throw new Error('No final assistant text was observed');
        await manager?.flush();
        return text;
      } finally { unsubscribe(); }
    }
    if (op === 'compact') { await session.compact(`Preserve the original user intent and every constraint. Authoritative immutable context:\n${config.context}`); await manager?.flush(); return; }
    if (op === 'setModel') {
      if (typeof value !== 'string') throw new Error('Model selector must be a string');
      const model = selectedModel(value);
      await session.setModel(model, undefined, { selector: `${model.provider}/${model.id}`, persist: false });
      emit('model_changed', { model: `${model.provider}/${model.id}` });
      return `${model.provider}/${model.id}`;
    }
    throw new Error(`Unknown worker operation: ${op}`);
  } finally { busy = false; activePromptAbort = undefined; activeOperation = undefined; settled.resolve(); }
}

function orphanStop() {
  terminating = true;
  activePromptAbort?.abort();
  denyPermits('Parent disconnected');
  for (const child of commands) { try { child.kill('SIGKILL'); } catch { /* Already reaped. */ } }
  // The parent launches a dedicated POSIX process group; killing it also stops SDK descendants.
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
}
process.on('disconnect', orphanStop);
process.on('SIGTERM', orphanStop);
process.on('SIGINT', orphanStop);
setInterval(() => {
  if (!process.connected || process.ppid !== parentPid || Date.now() - lastHeartbeat > 5_000) orphanStop();
}, 1_000).unref();
process.on('message', message => {
  const frame = message as Frame;
  if (frame.kind === 'heartbeat') { lastHeartbeat = Date.now(); return; }
  if (frame.kind === 'permit_result' && typeof frame.id === 'number') {
    const pending = permits.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    permits.delete(frame.id);
    try { assertLive(); if (frame.allowed !== true) throw new Error(frame.reason ?? 'Parent denied tool execution'); pending.resolve(); }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
    return;
  }
  if (frame.kind !== 'request' || typeof frame.id !== 'number' || typeof frame.op !== 'string') return;
  // Never await this handler: abort, steering, heartbeats, and permit ACKs must pass a pending prompt.
  const started = Date.now();
  emit('operation_start', { id: frame.id, op: frame.op });
  void operation(frame.op, frame.value).then(value => {
    emit('operation_end', { id: frame.id, op: frame.op, durationMs: Date.now() - started });
    send({ kind: 'response', id: frame.id, ok: true, value });
    if (frame.op === 'close') setTimeout(() => process.exit(0), 20);
  }, error => {
    const message = errorText(error);
    emit('operation_error', { id: frame.id, op: frame.op, durationMs: Date.now() - started, error: message });
    if (process.connected) send({ kind: 'response', id: frame.id, ok: false, error: message });
  });
});
