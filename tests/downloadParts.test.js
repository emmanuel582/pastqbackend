import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pastq-parts-'));process.env.DATA_DIR=temp;
const {partitionBundle,partFile}=await import('../services/library/downloadParts.js');
test.after(()=>{fs.rmSync(temp,{recursive:true,force:true});delete process.env.DATA_DIR;});
const asset='a'.repeat(64);
test('partitions subjects and source papers without dropping or duplicating records or solution diagrams',()=>{
 const questions=Array.from({length:205},(_,id)=>({id,subject:id<103?'Biology':'Physics',year:id<150?'2020':null,sourceSet:id<150?'2020':'Topic bank',question:'Q'+id,options:['A','B'],correct:0,answerHtml:id===0?`<img src="pastq-asset:${asset}">`:''}));
 const bundle={id:'test-parts',updated_at:'2026-10-19',questions,assets:{[asset]:{mime:'image/png',data:'AQ=='},unused:{mime:'image/png',data:'Ag=='}}};
 const manifest=partitionBundle(bundle);assert.equal(manifest.parts.reduce((n,p)=>n+p.count,0),205);assert.ok(manifest.parts.every(p=>p.count<=100));
 const restored=manifest.parts.flatMap(part=>{const bytes=fs.readFileSync(partFile(bundle.id,part.hash));assert.equal(createHash('sha256').update(bytes).digest('hex'),part.hash);const payload=JSON.parse(bytes);if(payload.questions.some(q=>q.id===0))assert.deepEqual(Object.keys(payload.assets),[asset]);return payload.questions});
 assert.equal(new Set(restored.map(q=>q.id)).size,205);assert.deepEqual(restored.sort((a,b)=>a.id-b.id),questions);assert.equal(manifest.bundle.questions,undefined);assert.equal(manifest.bundle.assets,undefined);
 assert.equal(partFile('../escape',manifest.parts[0].hash),null);
});
