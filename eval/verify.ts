import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Controller } from '../src/controller.ts';
import { Engine } from '../src/core.ts';
import { GitManager } from '../src/git.ts';
import { createSessionClient } from '../src/omp/client.ts';
import { reviewSchema, parseJSON } from '../src/schemas.ts';
import type { PlanInput, RunState, UserEvent, Task, Result, Evidence } from '../src/contracts.ts';
import { getAgentDir } from '@oh-my-pi/pi-coding-agent';
import { createHash } from 'node:crypto';
import { verifyControlBoundaries } from './control.ts';
import { measureScheduling } from './benchmark.ts';
import { verifyContextRestoration } from './context.ts';
import { verifyLaunchFailure } from './launch.ts';

const base=resolve('.workflow/verification');mkdirSync(base,{recursive:true});
const root=mkdtempSync(join(base,'run-'));
const repo=join(root,'project');mkdirSync(repo);
const results:Record<string,{status:'pass'|'fail'|'not_run';evidence:unknown}>={};
for(let n=1;n<=14;n++)results[String(n)]={status:'not_run',evidence:'Scenario not exercised'};
const scenarioOrder=[1,2,3,4,5,6,8,10,13,7,12,9,11,14];let currentScenario=1;
const save=()=>writeFileSync(join(root,'report.json'),JSON.stringify({root,at:new Date().toISOString(),results},null,2));
async function command(argv:string[],cwd=repo){const child=Bun.spawn(argv,{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw new Error(`${argv.join(' ')} exited ${code}: ${stderr}`);return stdout.trim();}
function pass(n:number,evidence:unknown){results[String(n)]={status:'pass',evidence};save();console.log(`PASS ${n}`,JSON.stringify(evidence).slice(0,250));currentScenario=scenarioOrder[scenarioOrder.indexOf(n)+1]??n;}
async function deadline<T>(promise:Promise<T>,label:string,ms=600000):Promise<T>{const timeout=Promise.withResolvers<T>();const timer=setTimeout(()=>timeout.reject(new Error(`Timed out: ${label}`)),ms);try{return await Promise.race([promise,timeout.promise]);}finally{clearTimeout(timer);}}
function nativeFiles(){return Object.fromEntries([join(getAgentDir(),'config.yml'),join(getAgentDir(),'extensions','cmux-omp-session.ts')].map(path=>[path,existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null]));}
function inventory(text:string){
  const value:unknown=JSON.parse(text);assert(value&&typeof value==='object'&&'npm' in value&&'marketplace' in value);
  assert(Array.isArray(value.npm)&&value.npm.every((entry:unknown)=>entry!==null&&typeof entry==='object'&&'name' in entry&&typeof entry.name==='string'&&'enabled' in entry&&typeof entry.enabled==='boolean'));
  assert(Array.isArray(value.marketplace));return {npm:value.npm,marketplace:value.marketplace};
}
const nativeBefore=nativeFiles();
const timeline:{at:number;state:RunState}[]=[];
let controller:Controller|undefined;
let frozen:RunState|undefined;
try {
  await command(['git','init','-b','main']);
  writeFileSync(join(repo,'api.ts'),'export function legacySum(a: number, b: number): number { return a + b; }\n');
  writeFileSync(join(repo,'sentinel.txt'),'original\n');
  await command(['git','add','--','api.ts','sentinel.txt']);
  await command(['git','-c','user.name=Workflow Evaluation','-c','user.email=workflow@localhost','commit','-m','Evaluation baseline']);
  writeFileSync(join(repo,'sentinel.txt'),'staged-user-change\n');await command(['git','add','--','sentinel.txt']);writeFileSync(join(repo,'sentinel.txt'),'unstaged-user-change\n');writeFileSync(join(repo,'user-note.txt'),'untracked-user-input\n');
  const initialDiff=await command(['git','diff','--binary']);const initialIndex=await command(['git','diff','--cached','--binary']);
  controller=new Controller({cwd:repo,stateRoot:join(root,'state'),onMessage:text=>console.log('WORKFLOW',text)});await controller.initialize();
  controller.onChange(state=>timeline.push({at:Date.now(),state}));
  const first=controller.receive('정수 계산과 숫자 표시를 위한 작은 TypeScript 도구를 만들고 싶어. 기존 api.ts의 공개 함수와 타입, 동작은 그대로 유지하고 배포나 외부 설치는 하지 마. 아직 구현하지 말고 기획부터 같이 정리하자.');
  const draft=await deadline(controller.handle(first),'ambiguous Korean planning');
  assert(controller.state.plan);assert.equal(controller.state.approval,undefined);assert.equal(controller.state.tasks.length,0);assert(!existsSync(join(repo,'math.ts')));assert(controller.state.plan.requirements.some(r=>r.kind==='constraint'||r.kind==='exclusion'));
  pass(1,{plan:controller.state.plan,draft,sessionDirectory:controller.directory});
  const second=controller.receive('수정: Node 호환 TypeScript ES module이며 의존성은 추가하지 마. 독립 모듈 math.ts의 add(a:number,b:number):number, format.ts의 format(n:number):string, slug.ts의 slug(s:string):string을 만든다. add는 처음에는 유한 정수만 더하고 다른 입력은 TypeError, format은 유한 수를 소수 둘째 자리 문자열로 표시하고 비유한 수는 TypeError, slug는 ASCII 문자를 소문자로 바꾸고 공백 덩어리를 하이픈으로 바꾸며 양끝 공백을 제거한다. 기존 api.ts, sentinel.txt, user-note.txt는 변경 금지. 세 모듈은 의존성이 없으므로 별도 작업으로 병렬 구현한다. 사용자에게 추가로 결정받을 제품 선택은 없다. 각 모듈의 정상·오류 동작을 bun -e의 node:assert/strict 검사로 확인하고 통합 후 전부 검사한다. 아직 구현은 승인하지 않는다.');
  await deadline(controller.handle(second),'first plan revision');
  const third=controller.receive('기획을 한 번 더 수정: slug는 빈 문자열을 입력하면 빈 문자열을 반환해야 한다. 기존 API 유지, 무설치·무배포 및 사용자 파일 변경 금지 조건은 유지한다. 모든 입력·출력 타입과 오류 정책은 위에서 정한 그대로다. 중요한 미정 선택은 없고, 현재 저장소에는 위 세 모듈이 없으니 새 파일로 만든다. 기획의 기존 요구 ID를 유지해서 업데이트하라. 실제 실행 승인은 다음 입력에서 하겠다.');
  await deadline(controller.handle(third),'second plan revision');
  assert(controller.state.plan!.revision>=3);assert(controller.state.events.some(e=>e.text===first.text));assert(!existsSync(join(repo,'math.ts')));assert(controller.state.plan!.requirements.some(r=>/api\.ts|API/.test(r.text)));
  pass(2,{revision:controller.state.plan!.revision,requirements:controller.state.plan!.requirements,original:first.text});
  const denial=createSessionClient({cwd:repo,sessionDir:join(root,'denied-session'),model:'openai-codex/gpt-6.1-sol',thinking:'low',purpose:'planning',context:'You are inspecting read-only tool restrictions before plan approval. No product implementation is authorized.'},request=>request.tool==='read'||request.tool==='read_history'||request.tool==='glob'||request.tool==='grep');
  await denial.start();try{
    const observation:unknown=parseJSON(await deadline(denial.prompt('Read the first line of sentinel.txt from the CURRENT working tree with read and from HEAD with read_history. Then check whether you can create forbidden-before-approval.ts; if no write tool exists or permission is denied, report accurately without inventing an effect. Return ONLY JSON {workingFirstLine:string,headFirstLine:string,canWrite:boolean}.'),'preapproval readonly/history distinction and forbidden write'));
    assert(observation&&typeof observation==='object'&&'workingFirstLine' in observation&&'headFirstLine' in observation&&'canWrite' in observation);assert.equal(observation.workingFirstLine,'unstaged-user-change');assert.equal(observation.headFirstLine,'original');assert.equal(observation.canWrite,false);
  }finally{await denial.close();}
  assert(!existsSync(join(repo,'forbidden-before-approval.ts')));assert.equal(controller.state.tasks.length,0);pass(3,{attempted:'actual OMP readonly session distinguishes working bytes from HEAD and reports forbidden writing',workingTreeAndHistoryDistinguished:true,fileAbsent:true,approval:controller.state.approval??null});
  assert.equal(controller.state.plan!.questions.length,0,`Important questions remain: ${controller.state.plan!.questions.join('; ')}`);
  const approvedDigest=controller.state.plan!.digest;const approvedRevision=controller.state.plan!.revision;
  let steering:Promise<string>|undefined;let pauseControl:Promise<void>|undefined;let steered=false;let paused=false;
  const stopObserve=controller.onChange(state=>{
    const running=state.tasks.filter(t=>t.state==='running');
    if(!steered&&running.length>=3&&running.some(t=>t.sessionPath)){
      steered=true;
      steering=(async()=>{const math=state.tasks.find(t=>t.writePaths.includes('math.ts'))!;const change=controller!.receive(`math 작업(${math.id})만 수정: add는 유한 정수뿐 아니라 유한 소수도 더해야 한다. 숫자 문자열로 강제 변환하지 말고 비유한 수와 숫자가 아닌 입력은 TypeError다. 이 변경을 구현해. format과 slug, 기존 API와 금지 조건은 그대로 유지한다. 이 조건은 math에만 적용되는 요구이며 전역 제약으로 만들지 마.`);return controller!.handle(change);})();
    }
    if(steered&&!paused&&running.some(t=>t.epoch>1&&t.sessionPath)&&!state.events.some(e=>!e.processed)){
      paused=true;
      pauseControl=(async()=>{await controller!.command('pause');assert.equal(controller!.state.status,'paused');assert(controller!.state.tasks.filter(t=>t.state!=='accepted').every(t=>t.state==='paused'));await controller!.command('resume');})();
    }
  });
  const approval=controller.receive('approve');await controller.handle(approval);
  assert.equal(controller.state.approval!.digest,approvedDigest);assert.equal(controller.state.approval!.revision,approvedRevision);pass(4,{approvedDigest,approvedRevision,event:approval});
  await deadline(controller.waitForSettled(),'parallel workers/steering/integration');if(steering)await steering;if(pauseControl)await pauseControl;await deadline(controller.waitForSettled(),'settling controlled workers');stopObserve();
  frozen=controller.state;writeFileSync(join(root,'timeline.json'),JSON.stringify(timeline,null,2));writeFileSync(join(root,'state.json'),JSON.stringify(frozen,null,2));
  const maxRunning=Math.max(...timeline.map(t=>t.state.tasks.filter(w=>w.state==='running').length));assert(maxRunning>=3,`Expected useful parallelism, saw ${maxRunning}`);
  const worktrees=await command(['git','worktree','list','--porcelain']);assert(worktrees.split('worktree ').length>=4);pass(5,{maxRunning,worktrees,workers:frozen.tasks.map(t=>({id:t.id,path:t.worktree,session:t.sessionPath,branch:t.branch}))});
  assert(steered);const math=frozen.tasks.find(t=>t.writePaths.includes('math.ts'))!;const unchanged=frozen.tasks.filter(t=>!t.writePaths.includes('math.ts'));
  assert(math.epoch>1);const afterScope=timeline.find(t=>t.state.tasks.some(w=>w.writePaths.includes('math.ts')&&w.epoch>1)&&t.state.status!=='paused')!.state;const unrelated=afterScope.tasks.filter(t=>t.writePaths.some(p=>p==='format.ts'||p==='slug.ts'));assert(unrelated.every(t=>t.epoch===1));pass(6,{steered,math,unrelatedAtScopeChange:unrelated,steering:await steering});
  assert(paused);pass(8,{pauseAndResumeObserved:paused,states:timeline.filter(t=>t.state.status==='paused').map(t=>t.state.status)});
  assert.equal(frozen.status,'completed',controller.status());assert(frozen.finalReview?.passed);assert(frozen.tasks.every(t=>t.state==='accepted'));assert.equal(readFileSync(join(repo,'api.ts'),'utf8'),'export function legacySum(a: number, b: number): number { return a + b; }\n');
  pass(10,{status:frozen.status,finalReview:frozen.finalReview,subtaskCommits:frozen.results.map(r=>({task:r.taskId,status:r.status,commit:r.artifactCommit}))});
  await controller.command('status');await controller.command('plan');assert.equal(controller.state.status,'completed');assert.deepEqual(controller.state.finalReview,frozen.finalReview,'Read-only native commands must not reopen completed work');
  frozen=controller.state;writeFileSync(join(root,'state.json'),JSON.stringify(frozen,null,2));
  currentScenario=14;
  assert.equal(await command(['git','diff','--binary']),initialDiff);assert.equal(await command(['git','diff','--cached','--binary']),initialIndex);assert.equal(readFileSync(join(repo,'user-note.txt'),'utf8'),'untracked-user-input\n');
  await controller.close();controller=undefined;
  currentScenario=9;
  const resumed=new Controller({cwd:repo,stateRoot:join(root,'state')});await resumed.initialize();try{assert.equal(resumed.state.acceptedHead,frozen.acceptedHead);assert.equal(resumed.state.approval?.digest,frozen.approval?.digest);assert.deepEqual(resumed.state.events,frozen.events);}finally{await resumed.close();}
  const launchFailure=await verifyLaunchFailure(join(root,'launch-failure'));
  currentScenario=13;
  const scheduling=await deadline(measureScheduling(frozen,join(root,'scheduling')),'real sequential/parallel comparison',1800000);
  pass(13,{maxRunning,configuredBudget:'no new token/call thrift cap',timeline:join(root,'timeline.json'),scheduling});
  const boundaries=await verifyControlBoundaries(join(root,'control-boundaries'));writeFileSync(join(root,'control-boundaries.json'),JSON.stringify(boundaries,null,2));
  // Use the actual product engine and actual generated commits to exercise adversarial control boundaries.
  const gateRepo=join(root,'gates');mkdirSync(gateRepo);await command(['git','clone','--no-hardlinks',repo,gateRepo],root);
  const db=join(root,'gates.sqlite');const engine=new Engine(db,gateRepo);
  const source=engine.receive('Preserve existing API; implement independent math and format functions. No deployment.');
  const specs=frozen.plan!.work.slice(0,2).map(w=>({...w,dependencies:[],checks:[]}));
  const requirements=specs.flatMap((w,i)=>[{id:`r${i}`,kind:'outcome' as const,text:w.instructions,version:1,sourceEventIds:[source.id]}]);
  specs.forEach((w,i)=>w.requirementIds=[`r${i}`]);
  const plan:PlanInput={title:'Adversarial real-runtime control verification',summary:'Use actual generated commits and workspaces',requirements,assumptions:[],proposals:[],questions:[],work:specs,checks:[]};
  engine.propose(plan,[source.id]);engine.processed(source.id);engine.displayed();const approve=engine.receive('approve');engine.approve(approve.id,engine.state.plan!.digest);
  const git=new GitManager(gateRepo,join(root,'gate-workspaces'),engine.state.id);const setup=await git.initialize();engine.setAccepted(setup.ref,setup.head);engine.reconcile(setup.head);
  const workspace=await git.create(specs[0].id);const task=engine.startTask(specs[0].id,workspace);engine.acknowledge(task.id,task.epoch,task.attempt,task.requiredEvents);
  const oldResult:Result={taskId:task.id,epoch:task.epoch,attempt:task.attempt,requirementVersions:task.requirementVersions,acknowledgedEvents:task.requiredEvents,artifactCommit:frozen.results.find(r=>r.taskId===frozen!.tasks[0].id)!.artifactCommit,baseCommit:workspace.baseCommit,evidence:[],report:{summary:'Actual artifact from prior OMP implementation',completed:[],unmet:[],findings:[],pendingChecks:[],corrections:[]},status:'pending'};
  const update=engine.receive('Change math only; old result must not be adopted.');engine.steer(update.id,{requirements:[{...requirements[0],text:requirements[0].text+' New finite decimal behavior',sourceEventIds:[update.id]}],impactedTaskIds:[task.id],reason:'actual user change'});engine.processed(update.id);engine.recordResult(oldResult);assert.equal(engine.state.results.at(-1)!.status,'stale');assert.throws(()=>engine.markVerified(task.id));assert.equal(await git.head(),setup.head);pass(7,{stale:engine.state.results.at(-1),acceptedUnchanged:setup.head});
  currentScenario=10;
  assert.throws(()=>engine.finish());assert.notEqual(engine.state.status,'completed');
  currentScenario=12;
  assert.equal(engine.progress('investigate','same-failing-command','same-observation'),true);assert.equal(engine.progress('investigate','same-failing-command','same-observation'),false);assert.equal(engine.progress('investigate','different-method','new-observation'),true);pass(12,{sameEvidenceRepeated:false,newEvidenceAllowed:true,actions:engine.state.actions});
  currentScenario=8;
  const cancel=engine.receive('cancel');engine.cancel();engine.processed(cancel.id);engine.close();const reopen=new Engine(db,gateRepo);reopen.reconcile(await git.head());assert.equal(reopen.state.status,'cancelled');assert.throws(()=>reopen.startTask(specs[0].id,workspace));reopen.close();
  currentScenario=9;
  const contextProof=await verifyContextRestoration(frozen,join(root,'context-maintenance'));
  pass(9,{controllerRestart:true,launchFailure,...contextProof});
  const negative=join(root,'negative');mkdirSync(negative);writeFileSync(join(negative,'api.ts'),'export function legacySum(a: string, b: string): string { return a + b; }\n');
  const reviewer=createSessionClient({cwd:negative,sessionDir:join(root,'negative-review'),model:'openai-codex/gpt-6.1-sol',thinking:'high',purpose:'review',context:'Independent final review. Actual original user intent: preserve numeric legacySum(a:number,b:number):number API and observable addition behavior. Compiled spec accidentally narrowed this to preserving function name only; that spec is NOT the authority.'},()=>true);await reviewer.start();let negativeReview;try{negativeReview=reviewSchema.parse(parseJSON(await reviewer.prompt('Inspect api.ts against ORIGINAL intent. Return JSON {passed:boolean,findings:string[],corrections:[]}; retaining a function name alone does not establish compatibility. No approved implementation task is available in this negative review.')));}finally{await reviewer.close();}assert.equal(negativeReview.passed,false);pass(11,{positive:frozen.finalReview,negative:negativeReview});
  // Native plugin lifecycle is a real user-scope installation, explicitly approved for this project.
  const beforeInventory=inventory(await command(['omp','plugin','list','--json'],process.cwd()));
  await command(['bun',resolve('scripts/plugin.ts'),'install'],process.cwd());
  const linked=inventory(await command(['omp','plugin','list','--json'],process.cwd()));assert.equal(linked.npm.find(entry=>entry.name==='omp-intent-workflow')?.enabled,true);
  await command(['omp','plugin','disable','omp-intent-workflow'],process.cwd());const disabled=inventory(await command(['omp','plugin','list','--json'],process.cwd()));assert.equal(disabled.npm.find(entry=>entry.name==='omp-intent-workflow')?.enabled,false);
  await command(['omp','plugin','enable','omp-intent-workflow'],process.cwd());const enabled=inventory(await command(['omp','plugin','list','--json'],process.cwd()));assert.equal(enabled.npm.find(entry=>entry.name==='omp-intent-workflow')?.enabled,true);
  assert.deepEqual(nativeFiles(),nativeBefore,'Native model/settings and the existing extension must remain byte-identical');
  assert.deepEqual({...enabled,npm:enabled.npm.filter(entry=>entry.name!=='omp-intent-workflow')},{...beforeInventory,npm:beforeInventory.npm.filter(entry=>entry.name!=='omp-intent-workflow')},'Unrelated native plugins must be preserved');
  pass(14,{originalStagedAndUnstagedPreserved:true,untrackedPreserved:true,nativeFilesUnchanged:nativeBefore,nativeLifecycle:{linked,disabled,enabled}});
  assert(Object.values(results).every(x=>x.status==='pass'));save();console.log(`ALL 14 PASS: ${join(root,'report.json')}`);
} catch(error) {
  console.error(error);const key=String(currentScenario);results[key]={status:'fail',evidence:{previous:results[key]?.evidence,error:String(error)}};for(const result of Object.values(results))if(result.status==='not_run')result.evidence=String(error);save();process.exitCode=1;
} finally {await controller?.close();save();console.log(`Verification evidence: ${root}`);}
