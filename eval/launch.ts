import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSessionClient} from '../src/omp/client.ts';

export async function verifyLaunchFailure(root:string){
  mkdirSync(root,{recursive:true});const bin=join(root,'bin');mkdirSync(bin);
  const bun=Bun.which('bun');assert(bun);
  // Real exec failure, not a mocked process: the executable's interpreter does not exist.
  writeFileSync(join(bin,'bun'),`#!${join(root,'missing-interpreter')}\n`,{mode:0o700});
  const child=Bun.spawn([bun,fileURLToPath(import.meta.url),'--child',root],{cwd:process.cwd(),env:{...process.env,PATH:bin},stdout:'pipe',stderr:'pipe'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},10000);
  try{
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    assert.equal(timedOut,false,'A failed launch must not leave a heartbeat/process keeping the caller alive');assert.equal(code,0,stderr);
    const proof={invalidInterpreterRejected:true,originalErrorPreserved:'ENOENT',failedLaunchPublishesNoSession:true,callerExitedAfterCleanup:true,childEvidence:stdout.trim()};writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2));return proof;
  }finally{clearTimeout(timer);}
}
if(import.meta.main){
  if(Bun.argv[2]==='--child'){
    const root=Bun.argv[3];assert(root);
    const client=createSessionClient({cwd:root,sessionDir:join(root,'sessions'),model:'openai-codex/gpt-6.1-sol',thinking:'low',purpose:'planning',context:'Launch-failure boundary; no inference is authorized.'},()=>false);
    try{await assert.rejects(client.start(),{code:'ENOENT'});assert.equal(client.info,undefined);}finally{await client.close();}
    console.log(JSON.stringify({error:'ENOENT',sessionPublished:false,closed:true}));
  }else{
    const parent=resolve('.workflow/launch-verification');mkdirSync(parent,{recursive:true});console.log(JSON.stringify(await verifyLaunchFailure(mkdtempSync(join(parent,'run-'))),null,2));
  }
}
