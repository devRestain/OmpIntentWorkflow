import { afterEach, mock, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core.ts';
import type { PlanInput, SessionClient, SessionInfo } from '../src/contracts.ts';

// Run this isolated file separately: its only replaced boundary is provider transport.
class Planner implements SessionClient {
  readonly info:SessionInfo={sessionPath:'isolated-planner',pid:process.pid,model:'deterministic'};
  readonly started=Promise.withResolvers<void>();
  readonly answer=Promise.withResolvers<string>();
  readonly correcting=Promise.withResolvers<void>();
  readonly correctedAnswer=Promise.withResolvers<string>();
  readonly prompts:string[]=[];
  closed=false;
  observe?: (event:unknown)=>void;
  async start(){return this.info;}
  async prompt(text:string){
    this.prompts.push(text);this.started.resolve();
    if(this.prompts.length===1)return this.answer.promise;
    if(this.prompts.length===2){this.correcting.resolve();return this.correctedAnswer.promise;}
    throw new Error('Planning correction must be bounded');
  }
  async steer(){}
  async abort(){}
  async compact(){}
  async setModel(){}
  async close(){this.closed=true;}
}
const planners:Planner[]=[];
mock.module('../src/omp/client.ts',()=>({createSessionClient:(_config:unknown,_permit:unknown,observe?:(event:unknown)=>void)=>{
  const client=planners.shift();assert(client,'Unexpected provider launch');client.observe=observe;return client;
}}));
// Load after the provider replacement; a static import would load the real transport first.
const {Controller}=await import('../src/controller.ts');
const roots:string[]=[];
const controllers:InstanceType<typeof Controller>[]=[];
afterEach(async()=>{await Promise.all(controllers.splice(0).map(controller=>controller.close()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});planners.length=0;});
function plan(sourceIds:number[],title='Recovered goal'):PlanInput {
  return {title,summary:'Preserve original scope without execution',requirements:[{id:'goal',kind:'outcome',text:'Preserve the raw requested goal',version:1,sourceEventIds:sourceIds}],assumptions:[],proposals:[],questions:[],work:[{id:'work',title:'Approved work only',instructions:'Implement only after exact approval',dependencies:[],requirementIds:['goal'],writePaths:['result.ts'],resources:[],checks:[]}],checks:[]};
}
async function fixture(messages?:string[]){
  const root=mkdtempSync(join(tmpdir(),'workflow-recovery-'));roots.push(root);
  const repo=join(root,'repo');mkdirSync(repo);
  const controller=new Controller({cwd:repo,stateRoot:join(root,'state'),onMessage:text=>{messages?.push(text);}});controllers.push(controller);await controller.initialize();
  return {controller,root,repo};
}
function nextPlanner(){const client=new Planner();planners.push(client);return client;}
function receipt(controller:InstanceType<typeof Controller>,id:number){return controller.state.events.find(event=>event.id===id)!;}

test('preapproval stops persist; global resume permits planning but never execution',()=>{
  const root=mkdtempSync(join(tmpdir(),'workflow-engine-recovery-'));roots.push(root);
  const db=join(root,'intent.sqlite');let engine=new Engine(db,root);
  try {
    const source=engine.receive('Original goal','user','  Original goal  '),epoch=engine.planningEpoch;
    engine.pause();assert.equal(engine.state.status,'paused');assert.throws(()=>engine.propose(plan([source.id]),[source.id],epoch),/Resume/);
    engine.close();engine=new Engine(db,root);assert.equal(engine.state.status,'paused');assert.equal(engine.state.events[0].processed,false);
    engine.resume();assert.equal(engine.state.status,'planning');assert.throws(()=>engine.propose(plan([source.id]),[source.id],epoch),/revoked/);
    engine.propose(plan([source.id]),[source.id]);assert.equal(engine.state.approval,undefined);assert.equal(engine.state.tasks.length,0);assert.equal(engine.state.events[0].rawText,'  Original goal  ');
    engine.cancel();engine.close();engine=new Engine(db,root);assert.equal(engine.state.status,'cancelled');engine.resume();assert.equal(engine.state.status,'planning');assert.equal(engine.state.approval,undefined);
    assert.throws(()=>engine.startTask('work',{path:root,branch:'not-created',baseCommit:'not-created'}));
  } finally {engine.close();}
});

test('pause closes active planner, leaves raw inputs pending, and rejects late results after resume',async()=>{
  const {controller,repo}=await fixture();const old=nextPlanner();
  const source=controller.receive('Build only result.ts; do not execute yet.','  Build only result.ts; do not execute yet.  ');
  const pending=controller.handle(source);const rejected=assert.rejects(pending,/revoked/);await old.started.promise;
  const queuedSource=controller.receive('Preserve the public API too.');const queued=controller.handle(queuedSource);const queuedRejected=assert.rejects(queued,/revoked/);
  await controller.command('pause');assert(old.closed);assert.equal(controller.state.status,'paused');assert.equal(receipt(controller,source.id).processed,false);
  const stopped=controller.receive('Keep external dependencies excluded.');await controller.handle(stopped);assert.equal(receipt(controller,stopped.id).processed,false);
  const fresh=nextPlanner();const recovery=controller.command('resume');await fresh.started.promise;
  old.answer.resolve(JSON.stringify(plan([source.id], 'Stale planner')));await rejected;await queuedRejected;
  assert.equal(controller.state.plan,undefined);fresh.answer.resolve(JSON.stringify(plan([source.id,queuedSource.id,stopped.id])));await recovery;
  assert.equal(controller.state.plan!.title,'Recovered goal');assert.equal(controller.state.approval,undefined);assert.equal(controller.state.tasks.length,0);assert.equal(existsSync(join(repo,'result.ts')),false);
  assert.deepEqual(controller.state.plan!.sourceEventIds,[source.id,queuedSource.id,stopped.id]);assert.equal(receipt(controller,source.id).rawText,source.rawText);assert(!controller.state.events.some(event=>!event.processed));
});

test('restart recovery rejects retained controls without replaying them and recompiles original inputs',async()=>{
  const {controller,repo,root}=await fixture();
  const source=controller.receive('Preserve this exact request.',' raw original request ');
  const controls=['/workflow resume','/workflow resume old-run-uuid','/workflow approve','/workflow new','/workflow status'].map(text=>controller.receive(text));
  const directory=controller.directory,id=controller.state.id;await controller.close();
  const restarted=new Controller({cwd:repo,stateRoot:join(root,'state')});controllers.push(restarted);await restarted.initialize();
  assert.equal(restarted.directory,directory);assert.equal(restarted.state.id,id);assert.equal(restarted.state.plan,undefined);
  const client=nextPlanner(),recovered=restarted.command('recover');await client.started.promise;
  for(const event of controls){assert.equal(receipt(restarted,event.id).processed,true);assert.match(receipt(restarted,event.id).rejected!,/not replayed/);}
  assert.equal(receipt(restarted,source.id).processed,false);client.answer.resolve(JSON.stringify(plan([source.id])));await recovered;
  assert.equal(restarted.state.id,id);assert.equal(restarted.state.approval,undefined);assert.equal(restarted.state.tasks.length,0);assert.equal(receipt(restarted,source.id).rawText,' raw original request ');assert.deepEqual(restarted.state.plan!.sourceEventIds,[source.id]);
});

test('failed controls settle their receipts; failed planning preserves its goal for a fresh recovery',async()=>{
  const {controller}=await fixture();
  for(const [action,args] of [['approve',''],['resume','missing-task'],['unknown','']]){
    await assert.rejects(controller.command(action,args));const event=controller.state.events.at(-1)!;assert(event.processed);assert.match(event.rejected!,/Rejected control/);
  }
  const failed=nextPlanner(),goal=controller.receive('Retain this goal through provider failure.');
  const pending=controller.handle(goal),failure=assert.rejects(pending,/Provider unavailable/);await failed.started.promise;failed.answer.reject(new Error('Provider unavailable'));await failure;
  assert(failed.closed);assert.equal(receipt(controller,goal.id).processed,false);
  const fresh=nextPlanner(),recovered=controller.command('recover');await fresh.started.promise;fresh.answer.resolve(JSON.stringify(plan([goal.id])));await recovered;
  assert.equal(receipt(controller,goal.id).processed,true);assert.equal(controller.state.approval,undefined);
});

test('explicit recovery supersedes a hung planner instead of queueing behind it',async()=>{
  const {controller}=await fixture();const old=nextPlanner(),goal=controller.receive('Recover this retained goal without executing.');
  const pending=controller.handle(goal),rejected=assert.rejects(pending,/revoked/);await old.started.promise;
  const fresh=nextPlanner(),recovered=controller.command('recover');await fresh.started.promise;assert(old.closed);
  fresh.answer.resolve(JSON.stringify(plan([goal.id])));await recovered;const digest=controller.state.plan!.digest;
  old.answer.resolve(JSON.stringify(plan([goal.id],'Late obsolete plan')));await rejected;
  assert.equal(controller.state.plan!.digest,digest);assert.equal(controller.state.approval,undefined);
});

test('restart recover preserves a global stop until explicit resume',async()=>{
  const {controller,repo,root}=await fixture();const goal=controller.receive('Keep this pending goal after restart.');await controller.command('pause');await controller.close();
  const restarted=new Controller({cwd:repo,stateRoot:join(root,'state')});controllers.push(restarted);await restarted.initialize();
  await restarted.command('recover');assert.equal(restarted.state.status,'paused');assert.equal(receipt(restarted,goal.id).processed,false);assert.equal(restarted.state.plan,undefined);
  const client=nextPlanner(),resumed=restarted.command('resume');await client.started.promise;client.answer.resolve(JSON.stringify(plan([goal.id])));await resumed;
  assert.equal(restarted.state.status,'planning');assert.equal(restarted.state.tasks.length,0);assert.equal(restarted.state.approval,undefined);
});

test('cancel plus new archives unfinished intent without changing the old run',async()=>{
  const {controller,repo}=await fixture();const source=controller.receive('Keep the cancelled original goal intact.',' original raw goal ');
  await assert.rejects(controller.command('new'),/pending/);const oldDirectory=controller.directory,oldId=controller.state.id;
  await controller.command('cancel');const transition=controller.command('new');const incoming=controller.receive('The next goal must remain pending.');await transition;
  assert.notEqual(controller.state.id,oldId);assert.equal(receipt(controller,incoming.id).text,incoming.text);assert.equal(receipt(controller,incoming.id).processed,false);
  const retained=new Engine(join(oldDirectory,'intent.sqlite'),realpathSync(repo),oldId);
  try {assert.equal(retained.state.status,'cancelled');assert.equal(retained.state.events.find(event=>event.id===source.id)!.processed,false);assert.equal(retained.state.events.find(event=>event.id===source.id)!.rawText,' original raw goal ');}finally{retained.close();}
});

test('plan with a goal plans that actual input instead of silently discarding it',async()=>{
  const {controller}=await fixture();const client=nextPlanner(),result=controller.command('plan','Inspect the actual repository without implementing.');await client.started.promise;
  const source=controller.state.events.at(-1)!;assert.equal(source.processed,false);client.answer.resolve(JSON.stringify(plan([source.id])));await result;
  assert.deepEqual(controller.state.plan!.sourceEventIds,[source.id]);assert(receipt(controller,source.id).processed);assert.equal(controller.state.approval,undefined);
});


test('empty-source policy and proposed methods are corrected without inventing user authority',async()=>{
  const {controller}=await fixture(),client=nextPlanner();
  const source=controller.receive('Implement result.ts without dependencies; preserve existing files.','  Implement result.ts without dependencies; preserve existing files.  ');
  const draft=plan([source.id]);
  draft.requirements.push({id:'preserve',kind:'constraint',text:'Preserve existing files',version:1,sourceEventIds:[source.id]});
  const unsupported=Array.from({length:7},(_,index)=>({id:`derived${index}`,kind:index<3?'constraint' as const:'acceptance' as const,text:`Repository-derived method ${index}`,version:1,sourceEventIds:[]}));
  draft.requirements.push(...unsupported);draft.work[0].requirementIds=draft.requirements.map(requirement=>requirement.id);
  const pending=controller.handle(source);client.answer.resolve(JSON.stringify(draft));await client.correcting.promise;
  assert.equal(controller.state.plan,undefined);assert.equal(receipt(controller,source.id).processed,false);assert.equal(controller.state.approval,undefined);
  const corrected={...draft,requirements:draft.requirements.slice(0,2),assumptions:unsupported.slice(0,3).map(requirement=>requirement.text),proposals:unsupported.slice(3).map(requirement=>requirement.text),work:[{...draft.work[0],requirementIds:['goal','preserve']}]};
  client.correctedAnswer.resolve(JSON.stringify(corrected));await pending;
  assert.deepEqual(controller.state.plan!.requirements.map(requirement=>requirement.sourceEventIds),[[source.id],[source.id]]);
  assert.deepEqual(controller.state.plan!.assumptions,corrected.assumptions);assert.deepEqual(controller.state.plan!.proposals,corrected.proposals);
  assert.equal(controller.state.plan!.requirements.some(requirement=>requirement.id.startsWith('derived')),false);
  assert.equal(receipt(controller,source.id).rawText,source.rawText);assert.equal(receipt(controller,source.id).processed,true);
  assert.equal(controller.state.tasks.length,0);assert.equal(controller.state.approval,undefined);
});

test('planning rejects control and nonexistent sources before accepting a corrected plan',async()=>{
  const {controller}=await fixture(),client=nextPlanner(),source=controller.receive('Plan result.ts only.');
  await controller.command('status');const control=controller.state.events.at(-1)!;
  const invalid=plan([source.id,control.id,999]);
  const pending=controller.handle(source);client.answer.resolve(JSON.stringify(invalid));await client.correcting.promise;
  assert.equal(controller.state.plan,undefined);assert.equal(receipt(controller,source.id).processed,false);
  client.correctedAnswer.resolve(JSON.stringify(plan([source.id])));await pending;
  assert.deepEqual(controller.state.plan!.requirements[0].sourceEventIds,[source.id]);assert.equal(controller.state.approval,undefined);
});

test('a second invalid response stops correction and preserves pending intent without publishing a plan',async()=>{
  const {controller}=await fixture(),client=nextPlanner(),source=controller.receive('Keep this goal through invalid model output.');
  const invalid=plan([]),pending=controller.handle(source),failure=assert.rejects(pending,/교정 후에도 검증에 실패/);
  client.answer.resolve(JSON.stringify(invalid));await client.correcting.promise;client.correctedAnswer.resolve(JSON.stringify(invalid));await failure;
  assert.equal(client.prompts.length,2);assert.equal(controller.state.plan,undefined);assert.equal(receipt(controller,source.id).processed,false);
  assert.equal(controller.state.approval,undefined);assert.equal(controller.state.tasks.length,0);
});

test('pause revokes a pending response correction and refuses its late valid answer',async()=>{
  const {controller}=await fixture(),client=nextPlanner(),source=controller.receive('Do not publish a stopped planning response.');
  const pending=controller.handle(source),failure=assert.rejects(pending,/revoked/);
  client.answer.resolve(JSON.stringify(plan([])));await client.correcting.promise;await controller.command('pause');
  client.correctedAnswer.resolve(JSON.stringify(plan([source.id])));await failure;
  assert.equal(controller.state.status,'paused');assert.equal(controller.state.plan,undefined);assert.equal(receipt(controller,source.id).processed,false);
  assert.equal(controller.state.approval,undefined);
});
