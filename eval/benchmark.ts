import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/controller.ts';
import { Engine } from '../src/core.ts';
import { GitManager } from '../src/git.ts';
import type { PlanInput, RunState } from '../src/contracts.ts';

/** Reuse an actual model-produced plan, then exercise the same production scheduler in both modes. */
export async function measureScheduling(source:RunState,root:string) {
  assert(source.plan&&source.approval);mkdirSync(root,{recursive:true});
  const origin=new GitManager(source.repo,join(root,'inputs'),randomUUID());await origin.initialize();
  const measurements: {mode:string;maxConcurrency:number;peakNativeSessions:number;wallMs:number;commit?:string;run:string;status:RunState['status'];finalReview?:RunState['finalReview']}[]=[];
  const evidence={sameFunctionalRequirements:true,separateApprovedSchedulingExperiments:true,additionalPlanningCalls:0,samplesPerMode:1,limitation:'Only these benchmark variants replace the original parallel-only scheduling constraint. Remote provider variability and evidence-driven repair are included; timings do not establish a universal speedup.',measurements};
  for(const [mode,maxConcurrency] of [['sequential',1],['parallel',3]] as const){
    const input=await origin.create(mode),stateRoot=join(root,mode,'state');
    const seed=new Controller({cwd:input.path,stateRoot,maxConcurrency});await seed.initialize();
    const run=seed.directory,id=seed.state.id;await seed.close();
    const engine=new Engine(join(run,'intent.sqlite'),input.path,id);
    try{
      const ids=new Map<number,number>();
      for(const event of source.events.filter(event=>source.plan!.sourceEventIds.includes(event.id))){
        const receipt=engine.receive(event.text,event.source,event.rawText,event.attachments);ids.set(event.id,receipt.id);engine.processed(receipt.id);
      }
      const policy=engine.receive(`This is a separately approved verification experiment comparing scheduling modes, not the original product acceptance run. For this ${mode} sample ONLY, replace the earlier parallel-only execution requirement with scheduler maxConcurrency=${maxConcurrency}. Preserve every functional requirement, API, file-ownership constraint, permission and exclusion. The original parallel obligation remains unchanged outside this explicitly scoped experiment.`);
      engine.processed(policy.id);
      const plan:PlanInput={title:source.plan.title,summary:source.plan.summary,requirements:source.plan.requirements.map(requirement=>({...requirement,sourceEventIds:requirement.sourceEventIds.map(ref=>{const mapped=ids.get(ref);assert(mapped);return mapped;})})),assumptions:source.plan.assumptions,proposals:source.plan.proposals,questions:[],work:source.plan.work,checks:source.plan.checks};
      assert(!plan.requirements.some(requirement=>requirement.id==='__benchmark_scheduling__'));
      plan.requirements.push({id:'__benchmark_scheduling__',kind:'constraint',text:policy.text,version:1,sourceEventIds:[policy.id]});
      engine.propose(plan,[...ids.values(),policy.id]);engine.displayed();const approval=engine.receive('approve');engine.approve(approval.id,engine.state.plan!.digest);
      const git=new GitManager(input.path,run,id),initial=await git.initialize();engine.setOriginalGit({...initial.snapshot,baselineCommit:initial.head});engine.setAccepted(initial.ref,initial.head);engine.reconcile(initial.head);
    }finally{engine.close();}
    const controller=new Controller({cwd:input.path,stateRoot,maxConcurrency,onMessage:text=>console.log('BENCHMARK',mode,text)});await controller.initialize();
    let peakNativeSessions=0;
    controller.onChange(state=>{peakNativeSessions=Math.max(peakNativeSessions,state.tasks.filter(task=>task.state==='running'&&task.pid&&task.sessionPath).length);});
    const started=performance.now();
    try{
      await controller.command('resume');await controller.waitForSettled();assert.equal(controller.state.status,'completed',controller.status());
      assert(controller.state.finalReview?.passed);assert.equal(peakNativeSessions,maxConcurrency);
    }finally{
      const state=controller.state;measurements.push({mode,maxConcurrency,peakNativeSessions,wallMs:Math.round(performance.now()-started),commit:state.acceptedHead,run,status:state.status,finalReview:state.finalReview});
      writeFileSync(join(root,'report.json'),JSON.stringify(evidence,null,2));await controller.close();
    }
  }
  return evidence;
}
