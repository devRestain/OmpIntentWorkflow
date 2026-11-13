import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createSessionClient} from '../src/omp/client.ts';
import {reviewContext} from '../src/context.ts';
import {parseJSON} from '../src/schemas.ts';
import type {RunState,SessionInfo} from '../src/contracts.ts';

interface NativeCompaction {type:'compaction';id:string;tokensBefore:number;firstKeptEntryId:string;}
export interface ContextRestorationProof {exactSession:string;actualCompaction:true;models:string[];behaviorAfterSwitch:string;behaviorAfterResume:string;nativeCompaction:NativeCompaction;fixtureSettings:string;}
function isCompaction(value:unknown):value is NativeCompaction{return value!==null&&typeof value==='object'&&'type' in value&&value.type==='compaction'&&'id' in value&&typeof value.id==='string'&&'tokensBefore' in value&&typeof value.tokensBefore==='number'&&'firstKeptEntryId' in value&&typeof value.firstKeptEntryId==='string';}

/** Exercise native summarization without changing production/global token policy or adding padding. */
export async function verifyContextRestoration(state:RunState,root:string):Promise<ContextRestorationProof>{
  mkdirSync(root,{recursive:true});const repo=join(root,'project');
  const clone=Bun.spawnSync(['git','clone','--no-hardlinks',state.repo,repo]);assert.equal(clone.exitCode,0,clone.stderr.toString());
  const settings=join(repo,'.omp','config.yml');mkdirSync(join(repo,'.omp'),{mode:0o700});
  writeFileSync(settings,'compaction:\n  keepRecentTokens: 256\n',{mode:0o600});
  const context=reviewContext(state),sessionDir=join(root,'sessions'),events:unknown[]=[];
  const observe=(event:unknown)=>events.push(event);
  const probe=createSessionClient({cwd:repo,sessionDir,model:'openai-codex/gpt-6.1-sol',thinking:'low',purpose:'review',context},()=>true,observe);
  let info:SessionInfo|undefined;let behaviorAfterSwitch='';
  try{
    info=await probe.start();
    await probe.prompt('Read api.ts. From the original raw input, explain its numeric public API preservation obligations; do not modify files.');
    await probe.prompt('Before this context-maintenance checkpoint, distinguish the latest math-only steering from the global existing-API, file-preservation, no-installation and no-deployment constraints. Cite the applicable original records rather than inventing new requirements.');
    await probe.compact();await probe.setModel('openai-codex/gpt-6.1-terra');
    behaviorAfterSwitch=await probe.prompt('Inspect api.ts. Would replacing legacySum parameters/result with strings preserve the original API? Return JSON {compatible:boolean,reason:string}.');
    const verdict:unknown=parseJSON(behaviorAfterSwitch);assert(verdict&&typeof verdict==='object'&&'compatible' in verdict);assert.equal(verdict.compatible,false);
  }finally{await probe.close();}
  assert(info);
  const frames:unknown[]=readFileSync(info.sessionPath,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const entry=frames.find(isCompaction);assert(entry,'Native history must contain an actual persisted compaction, not a no-op');
  const nativeCompaction:NativeCompaction={type:entry.type,id:entry.id,tokensBefore:entry.tokensBefore,firstKeptEntryId:entry.firstKeptEntryId};
  const exact=createSessionClient({cwd:repo,sessionDir,sessionPath:info.sessionPath,model:'openai-codex/gpt-6.1-terra',thinking:'low',purpose:'review',context},()=>true,observe);
  let behaviorAfterResume='';
  try{
    const reopened=await exact.start();assert.equal(reopened.sessionPath,info.sessionPath);
    behaviorAfterResume=await exact.prompt('From the original raw input and valid changes, is deployment or external installation authorized? Return JSON {authorized:boolean,reason:string}.');
    const verdict:unknown=parseJSON(behaviorAfterResume);assert(verdict&&typeof verdict==='object'&&'authorized' in verdict);assert.equal(verdict.authorized,false);
  }finally{await exact.close();}
  const models=events.flatMap(event=>event!==null&&typeof event==='object'&&'type' in event&&event.type==='model_request'&&'model' in event&&typeof event.model==='string'?[event.model]:[]);
  assert(models.includes('openai-codex/gpt-6.1-sol')&&models.includes('openai-codex/gpt-6.1-terra'));
  const proof:ContextRestorationProof={exactSession:info.sessionPath,actualCompaction:true,models:[...new Set(models)],behaviorAfterSwitch,behaviorAfterResume,nativeCompaction,fixtureSettings:settings};
  writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2));return proof;
}
