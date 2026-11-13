import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../src/core.ts';
import { GitManager } from '../src/git.ts';
import type { PlanInput, Result, Task, Workspace } from '../src/contracts.ts';

/** Exercise production state/Git boundaries with actual refs; no reference model or provider substitute. */
export async function verifyControlBoundaries(root:string) {
  mkdirSync(root,{recursive:true});const repo=join(root,'repo');mkdirSync(repo);
  const gitRun=async(args:string[])=>{const p=Bun.spawn(['git',...args],{cwd:repo,stdout:'pipe',stderr:'pipe'});const [code,out,error]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);assert.equal(code,0,error);return out.trim();};
  await gitRun(['init','-b','main']);writeFileSync(join(repo,'a.ts'),'export const a = 1;\n');writeFileSync(join(repo,'b.ts'),'export const b = 2;\n');await gitRun(['add','.']);await gitRun(['-c','user.name=Workflow Check','-c','user.email=workflow@localhost','commit','-m','control baseline']);
  const db=join(root,'state.sqlite');let engine=new Engine(db,repo);
  assert.throws(()=>new Engine(db,repo),/live writer/);
  const source=engine.receive('Keep API types and behavior; update a and b independently. No deployment.');
  const plan:PlanInput={title:'Production control boundary check',summary:'Independent modules',requirements:[{id:'a',kind:'outcome',text:'a must be 3',version:1,sourceEventIds:[source.id]},{id:'b',kind:'outcome',text:'b must be 4',version:1,sourceEventIds:[source.id]},{id:'preserve',kind:'constraint',text:'Keep public API types and behavior; no deployment',version:1,sourceEventIds:[source.id]}],assumptions:[],proposals:[],questions:[],work:['a','b'].map(id=>({id,title:id,instructions:`Change ${id}`,dependencies:[],requirementIds:[id],writePaths:[id+'.ts'],resources:[],checks:[]})),checks:[]};
  engine.propose({...plan,work:[],questions:['Resolve the product scope before assigning execution work']},[source.id]);engine.processed(source.id);engine.displayed();
  const draftApproval=engine.receive('approve');assert.throws(()=>engine.approve(draftApproval.id,engine.state.plan!.digest));engine.processed(draftApproval.id,'Rejected: unresolved draft is not executable');assert.equal(engine.state.approval,undefined);
  engine.propose({...plan,work:[plan.work[0]]},[source.id]);engine.displayed();
  const incompleteApproval=engine.receive('approve');assert.throws(()=>engine.approve(incompleteApproval.id,engine.state.plan!.digest));engine.processed(incompleteApproval.id,'Rejected: required outcome b has no assigned work');assert.equal(engine.state.tasks.length,0);
  engine.propose(plan,[source.id]);engine.processed(source.id);engine.displayed();const digest=engine.state.plan!.digest;
  const oldApproval=engine.receive('approve');const amendment=engine.receive('Change a to 5, but do not start yet.');engine.propose({...plan,requirements:[{...plan.requirements[0],text:'a must be 5',sourceEventIds:[amendment.id]},...plan.requirements.slice(1)]},[amendment.id]);engine.processed(amendment.id);engine.displayed();assert.throws(()=>engine.approve(oldApproval.id,digest));assert.throws(()=>engine.approve(oldApproval.id,engine.state.plan!.digest));engine.processed(oldApproval.id);
  const foreign=engine.receive('approve','control');assert.throws(()=>engine.approve(foreign.id,engine.state.plan!.digest));engine.processed(foreign.id);
  const approval=engine.receive('approve');engine.approve(approval.id,engine.state.plan!.digest);
  const git=new GitManager(repo,join(root,'workspaces'),engine.state.id);const initialized=await git.initialize();engine.setAccepted(initialized.ref,initialized.head);engine.reconcile(initialized.head);
  const wa=await git.create('a-first'),wb=await git.create('b-first');const ta=engine.startTask('a',wa),tb=engine.startTask('b',wb);
  assert.throws(()=>engine.acknowledge('a',ta.epoch,ta.attempt,ta.requiredEvents.slice(1)));assert.equal(engine.permit('a',ta.epoch,ta.attempt),false);engine.acknowledge('a',ta.epoch,ta.attempt,ta.requiredEvents);engine.acknowledge('b',tb.epoch,tb.attempt,tb.requiredEvents);assert(engine.permit('b',tb.epoch,tb.attempt));
  const unmapped=engine.receive('Verification only: check rejection of unmapped compiled work; do not add product features.');
  assert.throws(()=>engine.steer(unmapped.id,{requirements:[{id:'unassigned',kind:'outcome',text:'Unmapped compiled addition',version:1,sourceEventIds:[unmapped.id]}],impactedTaskIds:['a'],reason:'Negative mapping boundary'}));engine.processed(unmapped.id,'Rejected verification-only unmapped change');
  const steering=engine.receive('Only a must be 6. Keep b running.');assert(!engine.permit('b',tb.epoch,tb.attempt));engine.steer(steering.id,{requirements:[{id:'a',kind:'outcome',text:'a must be 6',version:1,sourceEventIds:[steering.id],scope:['a']}],impactedTaskIds:['a'],reason:'Explicit scoped user change'});engine.processed(steering.id);assert(engine.permit('b',tb.epoch,tb.attempt));assert.equal(engine.state.tasks.find(t=>t.id==='b')!.epoch,tb.epoch);assert.throws(()=>engine.acknowledge('a',ta.epoch,ta.attempt,ta.requiredEvents));
  const current=engine.startTask('a',await git.create('a-current'));engine.acknowledge('a',current.epoch,current.attempt,current.requiredEvents);
  const workspace:Workspace={path:current.worktree!,branch:current.branch!,baseCommit:current.baseCommit!};
  writeFileSync(join(workspace.path,'a.ts'),'export const a = 5;\n');const failedArtifact=await git.commit(workspace,'first incorrect implementation');
  const failedEvidence=await git.checks(workspace.path,[{command:['bun','-e',"import assert from 'node:assert/strict';import {a} from './a.ts';assert.equal(a,6)"],description:'Current approved a behavior'}],failedArtifact);
  assert(failedEvidence.some(item=>item.exitCode!==0));
  const report:Result={taskId:'a',epoch:current.epoch,attempt:current.attempt,requirementVersions:current.requirementVersions,acknowledgedEvents:current.requiredEvents,artifactCommit:failedArtifact,baseCommit:current.baseCommit!,evidence:failedEvidence,report:{summary:'Actual Git artifact',completed:['a'],unmet:[],findings:[],pendingChecks:[],corrections:[]},status:'pending'};
  engine.recordResult(report);assert.equal(engine.state.results.at(-1)!.status,'rejected');assert.throws(()=>engine.markVerified('a'));
  writeFileSync(join(workspace.path,'a.ts'),'export const a = 6;\n');const artifact=await git.commit(workspace,'corrected implementation');
  assert.equal(await gitRun(['rev-list','--parents','-n','1',artifact]),`${artifact} ${workspace.baseCommit}`,'Corrected artifact must include the complete task delta, not depend on the rejected commit');
  assert((await gitRun(['for-each-ref','--format=%(objectname)','refs/omp'])).split('\n').includes(failedArtifact),'Failed artifacts must remain recoverable');
  engine.recordResult({...report,artifactCommit:artifact,evidence:await git.checks(workspace.path,[{command:['bun','-e',"import assert from 'node:assert/strict';import {a} from './a.ts';assert.equal(a,6)"],description:'Current approved a behavior'}],artifact)});
  engine.markVerified('a');const candidate=await git.candidate([artifact]);assert.equal(await gitRun(['show',`${candidate.commit}:a.ts`]),'export const a = 6;');const adoption=engine.prepareAdoption(['a'],candidate.oldHead,candidate.commit);
  const during=engine.receive('What is the current status?');assert.throws(()=>engine.acceptAdoption(adoption.id,()=>git.adoptSync(candidate.commit,candidate.oldHead)));assert.equal(await git.head(),candidate.oldHead);engine.processed(during.id);assert.throws(()=>engine.acceptAdoption(adoption.id,()=>git.adoptSync(candidate.commit,candidate.oldHead)));engine.abandonAdoption(adoption.id,'A new input arrived during candidate verification');
  const recovery=engine.prepareAdoption(['a'],candidate.oldHead,candidate.commit);git.adoptSync(candidate.commit,candidate.oldHead);engine.close();engine=new Engine(db,repo);engine.reconcile(await git.head());assert.equal(engine.state.adoptions.find(a=>a.id===recovery.id)!.phase,'accepted');assert.equal(engine.state.tasks.find(t=>t.id==='a')!.state,'accepted');assert.throws(()=>engine.acceptAdoption(recovery.id));assert.throws(()=>engine.finish());
  engine.recoverTask('b');const restored=engine.startTask('b',await git.create('b-restored'));engine.acknowledge('b',restored.epoch,restored.attempt,restored.requiredEvents);
  const bWorkspace:Workspace={path:restored.worktree!,branch:restored.branch!,baseCommit:restored.baseCommit!};writeFileSync(join(bWorkspace.path,'b.ts'),'export const b = 4;\n');
  const bArtifact=await git.commit(bWorkspace,'b implementation');engine.recordResult({...report,taskId:'b',epoch:restored.epoch,attempt:restored.attempt,requirementVersions:restored.requirementVersions,acknowledgedEvents:restored.requiredEvents,artifactCommit:bArtifact,baseCommit:restored.baseCommit!,evidence:[]});engine.markVerified('b');
  const combined=await git.candidate([bArtifact]);const merge=engine.prepareAdoption(['b'],combined.oldHead,combined.commit);engine.acceptAdoption(merge.id,()=>git.adoptSync(combined.commit,combined.oldHead));
  engine.finalReview(combined.commit,false,['Independent raw-intent review found a defect in a']);
  assert.throws(()=>engine.requestCorrection([{taskId:'outside-approved-work',instructions:'Create a new feature'}]));
  const approvedDigest=engine.state.approval!.digest,approvedRequirements=engine.state.plan!.requirements;
  engine.requestCorrection([{taskId:'a',instructions:'Repair the evidence-backed defect without narrowing the original requirement'}]);
  const correctionAttempt=engine.startTask('a',await git.create('a-correction'));assert(correctionAttempt.epoch>current.epoch);assert.equal(engine.permit('a',correctionAttempt.epoch,correctionAttempt.attempt),false);assert.equal(engine.state.tasks.find(task=>task.id==='b')!.state,'accepted');
  assert.equal(engine.state.approval!.digest,approvedDigest);assert.deepEqual(engine.state.plan!.requirements,approvedRequirements);assert.throws(()=>engine.finish());
  const cancel=engine.receive('cancel');engine.cancel();engine.processed(cancel.id);const id=engine.state.id;engine.close();engine=new Engine(db,repo,id);engine.reconcile(await git.head());assert.equal(engine.state.status,'cancelled');assert.throws(()=>engine.startTask('b',wb));
  const resume=engine.receive('resume b');engine.resume(['b']);engine.processed(resume.id);assert.equal(engine.state.status,'cancelled','A partial resume must not clear a global cancellation');engine.close();
  const reviewCorrection=await verifyReadOnlyCorrection(join(root,'review-correction'));
  return {db,repo,acceptedRef:initialized.ref,acceptedCommit:await git.head(),staleApprovalRejected:true,untrustedApprovalRejected:true,ackHolesRejected:true,scopedSteering:true,pendingInputCASBlocked:true,crashReconciledOnce:true,partialCompletionRejected:true,cancellationPersists:true,failedCheckRepair:true,completeRepairDelta:true,failedArtifactRetained:true,scopedReviewCorrection:true,reviewCorrection};
}
async function verifyReadOnlyCorrection(root:string){
  mkdirSync(root,{recursive:true});const repo=join(root,'repo');mkdirSync(repo);
  for(const argv of [['git','init','-b','main'],['git','-c','user.name=Workflow Check','-c','user.email=workflow@localhost','commit','--allow-empty','-m','review baseline']]){const p=Bun.spawnSync(argv,{cwd:repo});assert.equal(p.exitCode,0,p.stderr.toString());}
  const engine=new Engine(join(root,'intent.sqlite'),repo),git=new GitManager(repo,join(root,'workspaces'),engine.state.id);
  try{
    const source=engine.receive('Implement a and b independently, review a, and preserve paused work.');
    const plan:PlanInput={title:'Read-only finding scope',summary:'Preserve independent and paused tasks',requirements:[{id:'goal',kind:'outcome',text:source.text,version:1,sourceEventIds:[source.id]}],assumptions:[],proposals:[],questions:[],checks:[],work:['a','b','review','later'].map(id=>({id,title:id,instructions:id,requirementIds:['goal'],dependencies:['review','later'].includes(id)?['a']:[],writePaths:['a','b'].includes(id)?[id+'.ts']:[],resources:[],checks:[]}))};
    engine.propose(plan,[source.id]);engine.processed(source.id);engine.displayed();const approval=engine.receive('approve');engine.approve(approval.id,engine.state.plan!.digest);
    const initial=await git.initialize();engine.setAccepted(initial.ref,initial.head);engine.reconcile(initial.head);
    for(const id of ['a','b']){
      const workspace=await git.create(id),task=engine.startTask(id,workspace);engine.acknowledge(id,task.epoch,task.attempt,task.requiredEvents);writeFileSync(join(workspace.path,id+'.ts'),`export const ${id} = 1;\n`);
      const artifactCommit=await git.commit(workspace,id);
      engine.recordResult({taskId:id,epoch:task.epoch,attempt:task.attempt,requirementVersions:task.requirementVersions,acknowledgedEvents:task.requiredEvents,artifactCommit,baseCommit:workspace.baseCommit,evidence:[],report:{summary:id,completed:[id],unmet:[],findings:[],pendingChecks:[],corrections:[]},status:'pending'});engine.markVerified(id);
      const candidate=await git.candidate([artifactCommit]),adoption=engine.prepareAdoption([id],candidate.oldHead,candidate.commit);engine.acceptAdoption(adoption.id,()=>git.adoptSync(candidate.commit,candidate.oldHead));
    }
    engine.pause(['later']);const before=engine.state;
    const workspace=await git.create('review'),review=engine.startTask('review',workspace);engine.acknowledge(review.id,review.epoch,review.attempt,review.requiredEvents);
    engine.recordResult({taskId:review.id,epoch:review.epoch,attempt:review.attempt,requirementVersions:review.requirementVersions,acknowledgedEvents:review.requiredEvents,artifactCommit:workspace.baseCommit,baseCommit:workspace.baseCommit,evidence:[],report:{summary:'Source-derived finding',completed:[],unmet:['a violates its approved requirement'],findings:[],pendingChecks:[],corrections:[{taskId:'a',instructions:'Repair a within its approved scope'}]},status:'pending'});
    assert.throws(()=>engine.requestCorrection([{taskId:'b',instructions:'Touch unrelated accepted work'}],review.id));
    const affected=engine.requestCorrection([{taskId:'a',instructions:'Repair the observed defect'}],review.id);
    assert(affected.includes('a')&&affected.includes('review')&&affected.includes('later'));assert(!affected.includes('b'));
    assert.equal(engine.state.tasks.find(task=>task.id==='b')!.epoch,before.tasks.find(task=>task.id==='b')!.epoch);assert.equal(engine.state.tasks.find(task=>task.id==='b')!.state,'accepted');assert.equal(engine.state.tasks.find(task=>task.id==='later')!.state,'paused');
    assert.equal(engine.permit(review.id,review.epoch,review.attempt),false);assert.equal(engine.state.results.at(-1)!.status,'stale');assert.deepEqual(engine.state.results.at(-1)!.report.unmet,['a violates its approved requirement']);
    return {readOnlyScopeGuard:true,unrelatedAcceptedWorkPreserved:true,pausedDependentsPreserved:true,revokedReviewCannotAct:true,failedFindingRetained:true};
  }finally{engine.close();}
}
if(import.meta.main){const parent=resolve('.workflow/control');mkdirSync(parent,{recursive:true});console.log(JSON.stringify(await verifyControlBoundaries(mkdtempSync(join(parent,'run-'))),null,2));}
