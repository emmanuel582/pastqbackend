import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pastq-reports-'));process.env.DATA_DIR=temp;
const {saveReport,listReports,resolveReport,closeQuestionReports}=await import('../services/library/questionReports.js');
test.after(()=>{closeQuestionReports();fs.rmSync(temp,{recursive:true,force:true});delete process.env.DATA_DIR;});
const input={id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',bundleId:'waec',questionId:'q1',version:'v1',category:'diagram',note:'Missing solution diagram'};
test('report retries are idempotent, owner isolated and keep correction provenance',()=>{
 const first=saveReport('owner-a',input,{subject:'Biology',year:'2020'});assert.equal(saveReport('owner-a',input,{subject:'Biology'}).createdAt,first.createdAt);
 assert.equal(listReports('owner-a').length,1);assert.equal(listReports('owner-b').length,0);assert.equal(resolveReport('owner-b',input.id,{status:'corrected'}),null);
 const resolved=resolveReport('owner-a',input.id,{status:'corrected',resolution:'Restored the original diagram.',correctedVersion:'v2'});assert.equal(resolved.version,'v1');assert.equal(resolved.correctedVersion,'v2');assert.equal(listReports(null,true)[0].owner,'owner-a');
});
