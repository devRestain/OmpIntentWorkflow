import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Controller } from '../src/controller.ts';
import { createHash } from 'node:crypto';

const parent=resolve('.workflow/input-verification');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'run-')),repo=join(root,'repo');mkdirSync(repo);
for(const argv of [['git','init','-b','main'],['git','-c','user.name=Input Check','-c','user.email=workflow@localhost','commit','--allow-empty','-m','input baseline']]){const p=Bun.spawnSync(argv,{cwd:repo});assert.equal(p.exitCode,0,p.stderr.toString());}
function chunk(type:string,data:Buffer){const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,checksum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(128,0);header.writeUInt32BE(128,4);header[8]=8;header[9]=2;
const pixels=Buffer.alloc(128*(1+128*3));for(let row=0;row<128;row++)for(let column=0;column<128;column++)pixels[row*(1+128*3)+1+column*3]=255;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const controller=new Controller({cwd:repo,stateRoot:join(root,'state')});await controller.initialize();
try {
  const text='첨부 이미지와 같은 배경색을 사용하는 단일 정적 HTML 페이지를 기획해 줘. 색상은 이미지에서 확인해 명시하고 외부 의존성이나 배포는 필요 없다. 지금은 기획만 하고 구현은 다음 승인까지 하지 마.';
  const event=controller.receive(text,`  ${text}  `,[{type:'image',mimeType:'image/png',data:png.toString('base64')}]);assert.equal(event.attachments?.[0].sha256,createHash('sha256').update(png).digest('hex'));
  const initialRun=controller.state.id;const pending=controller.handle(event);
  await assert.rejects(controller.command('new'),/pending/);assert.equal(controller.state.id,initialRun);
  const plan=await pending;assert(/red|빨강|빨간|적색|#ff0000|rgb\(255[,\s]+0[,\s]+0\)/i.test(plan),'Actual image color was not preserved in the plan');assert.equal(controller.state.approval,undefined);
  const oldRun=controller.state.id;const transition=controller.command('new');const incoming=controller.receive('새 목표도 기획 상태에서 대기해. 아직 구현하지 마.');await transition;assert.notEqual(controller.state.id,oldRun);assert(controller.state.events.some(e=>e.id===incoming.id&&e.text===incoming.text));
  const proof={actualImagePlanning:true,expectedColor:'red',attachment:event.attachments?.[0],rawTextPreserved:event.rawText===`  ${text}  `,startupNewRejectedWithoutLoss:true,inputDuringNewRetained:true,plan};writeFileSync(join(root,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({proof:join(root,'proof.json'),...proof},null,2));
}finally{await controller.close();}
