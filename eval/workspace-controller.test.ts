import { afterEach, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Engine } from '../src/core.ts';
import type { PlanInput, SessionClient, WorkerConfig } from '../src/contracts.ts';

// The provider alone is deterministic; controllers, Git worktrees, checks and journals are real.
let response:PlanInput;
const outputs:Record<string,string>={'one/value.txt':'one result\n','two/value.txt':'two result\n','docs/result.txt':'loose result\n'};
mock.module('../src/omp/client.ts',()=>({createSessionClient:(config:WorkerConfig):SessionClient=>({
  info:undefined,
  async start(){return {sessionPath:join(config.sessionDir,'fixture.jsonl'),pid:process.pid,model:'fixture/model'};},
  async prompt(text){
    if(text.startsWith('Before any implementation')){
      const match=/\{epoch:(\d+),attempt:(\d+),eventIds:(\[[^\]]*\])\}/.exec(text)!;
      return JSON.stringify({epoch:Number(match[1]),attempt:Number(match[2]),eventIds:JSON.parse(match[3])});
    }
    if(config.purpose==='review'){
      const passed=Object.entries(outputs).every(([path,expected])=>readFileSync(join(config.cwd,path),'utf8')===expected);
      return JSON.stringify({passed,findings:passed?[]:['Missing a cross-repository or loose-file result'],corrections:[]});
    }
    if(config.writePaths?.length){
      for(const path of config.writePaths){assert(path in outputs);mkdirSync(dirname(join(config.cwd,path)),{recursive:true});writeFileSync(join(config.cwd,path),outputs[path]);}
      return JSON.stringify({summary:'Fixture implementation',completed:config.writePaths,unmet:[],findings:[],pendingChecks:[],corrections:[]});
    }
    return JSON.stringify(response);
  },
  async steer(){},async abort(){},async compact(){},async setModel(){},async close(){},
})}));
// Test module boundary: bind the provider replacement before loading its consumer.
const {Controller}=await import('../src/controller.ts');
const roots:string[]=[],controllers:InstanceType<typeof Controller>[]=[];
afterEach(async()=>{for(const controller of controllers.splice(0))await controller.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function command(cwd:string,args:string[]){const child=Bun.spawnSync(['git',...args],{cwd});assert.equal(child.exitCode,0,child.stderr.toString());return child.stdout.toString().trim();}
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'workflow-workspace-controller-')));roots.push(root);
  const source=join(root,'source');mkdirSync(join(source,'docs'),{recursive:true});writeFileSync(join(source,'README.md'),'Workspace guide\n');
  for(const name of ['one','two']){
    const repo=join(source,name);mkdirSync(repo);command(repo,['init','-b','main']);writeFileSync(join(repo,'input.txt'),'original\n');command(repo,['add','input.txt']);command(repo,['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline']);
  }
  const controller=new Controller({cwd:source,stateRoot:join(root,'state'),maxConcurrency:2});controllers.push(controller);
  return {root,source,controller};
}
function executablePlan(id:number):PlanInput {
  const final={command:['bun','-e',`import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';for(const [path,expected] of Object.entries(${JSON.stringify(outputs)}))assert.equal(readFileSync(path,'utf8'),expected);`],description:'All repository and loose-file outputs compose at one workspace revision'};
  return {title:'Cross-repository result',summary:'Preserve distinct repositories and loose source files',requirements:[{id:'goal',kind:'outcome',text:'Produce all three outputs without changing source checkouts',version:1,sourceEventIds:[id]}],assumptions:[],proposals:[],questions:[],work:[{id:'one',title:'One and loose files',instructions:'Create one/value.txt and docs/result.txt',dependencies:[],requirementIds:['goal'],writePaths:['one/value.txt','docs/result.txt'],resources:[],checks:[]},{id:'two',title:'Second repository',instructions:'Create two/value.txt',dependencies:[],requirementIds:['goal'],writePaths:['two/value.txt'],resources:[],checks:[]}],checks:[final]};
}

test('approve from a non-Git root executes, composes and reviews nested repositories plus loose files',async()=>{
  const {source,controller}=fixture();
  const first=join(source,'one');writeFileSync(join(first,'input.txt'),'staged\n');command(first,['add','input.txt']);writeFileSync(join(first,'input.txt'),'working\n');writeFileSync(join(first,'untracked.txt'),'user note\n');
  const before=Object.fromEntries(['one','two'].map(name=>[name,{head:command(join(source,name),['rev-parse','HEAD']),index:readFileSync(join(source,name,'.git/index')).toString('hex')}])) as Record<string,{head:string;index:string}>;
  await controller.initialize();const goal=controller.receive('Produce one/value.txt, two/value.txt, and docs/result.txt without changing originals.');response=executablePlan(goal.id);await controller.handle(goal);
  await controller.command('approve');await controller.waitForSettled();
  assert.equal(controller.state.status,'completed',controller.status());assert(controller.state.finalReview?.passed);assert.equal(controller.state.tasks.filter(task=>task.state==='accepted').length,2);
  assert(controller.state.integrationEvidence?.some(item=>item.exitCode===0&&item.commit===controller.state.acceptedHead));
  const original=controller.state.originalGit as {kind:string;components:{prefix:string}[]};assert.equal(original.kind,'workspace');assert(original.components.some(item=>item.prefix==='one'));assert(original.components.some(item=>item.prefix==='two'));
  assert.equal(existsSync(join(source,'.git')),false);for(const path of Object.keys(outputs))assert.equal(existsSync(join(source,path)),false);
  assert.equal(readFileSync(join(first,'input.txt'),'utf8'),'working\n');assert.equal(readFileSync(join(first,'untracked.txt'),'utf8'),'user note\n');
  for(const name of ['one','two']){assert.equal(command(join(source,name),['rev-parse','HEAD']),before[name].head);assert.equal(readFileSync(join(source,name,'.git/index')).toString('hex'),before[name].index);}
},30_000);

test('failed workspace preparation never records an approval or dispatchable tasks',async()=>{
  const {source,controller}=fixture();writeFileSync(join(source,'docs/private.txt'),'sk-'+ 'x'.repeat(40));await controller.initialize();
  const goal=controller.receive('Review docs/private.txt without leaking secrets.');response=executablePlan(goal.id);response.work=[{...response.work[0],writePaths:['docs/private.txt']}];response.checks=[];await controller.handle(goal);
  await assert.rejects(controller.command('approve'),/Sensitive|sensitive/);
  assert.equal(controller.state.approval,undefined);assert.equal(controller.state.tasks.length,0);assert.equal(controller.state.events.at(-1)!.processed,true);assert(controller.state.events.at(-1)!.rejected);
  assert.equal(existsSync(join(source,'.git')),false);
});

test('a previously approved non-Git run recovers without replacing its displayed approval',async()=>{
  const {root,source,controller}=fixture();
  const key=createHash('sha256').update(source).digest('hex').slice(0,20),run='12345678-1234-1234-1234-123456789abc',runRoot=join(root,'state',key,'runs',run);mkdirSync(runRoot,{recursive:true});writeFileSync(join(root,'state',key,'active.json'),JSON.stringify({id:run}));
  const seed=new Engine(join(runRoot,'intent.sqlite'),source,run),goal=seed.receive('Complete all three result files.');const plan=executablePlan(goal.id);seed.propose(plan,[goal.id]);seed.processed(goal.id);seed.displayed();const approval=seed.receive('approve');seed.approve(approval.id,seed.state.plan!.digest);const acceptedApproval=seed.state.approval;seed.close();
  await controller.initialize();assert.deepEqual(controller.state.approval,acceptedApproval);assert.equal(controller.state.id,run);
  await controller.command('recover');await controller.waitForSettled();
  assert.equal(controller.state.status,'completed',controller.status());assert.deepEqual(controller.state.approval,acceptedApproval);assert.equal(existsSync(join(source,'.git')),false);
},30_000);
