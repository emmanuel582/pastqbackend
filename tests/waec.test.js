import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildWaecCollections } from '../services/library/waec.js';

const row = { id: 'source-id', practiceKey: 'source:key', type: 'mcq', subject: 'Accounts', question: 'Question', questionHtml: '<div>Question</div>', options: ['First','Second'], optionsHtml: ['<div>First</div>','<div>Second</div>'], correct: 1, explanation: '', explanationHtml: '', year: 2025, paper: '2025', bank: 'past_questions', hierarchy: [{ attributes: { ntxt: '1' } }] };
describe('WAEC structured import', () => {
  it('partitions every objective, theory and short-answer record without losing source metadata', () => {
    const records = [row, {...row,id:'t',practiceKey:'theory:key',type:'theory',options:[],optionsHtml:[],correct:null,answerText:'Solution'}, {...row,id:'s',practiceKey:'short:key',type:'short_answer',options:['True'],optionsHtml:['<div>True</div>'],correct:null,answerText:'True',year:null,bank:'topic_practice'}];
    const [cbt,theory] = buildWaecCollections(records,()=>assert.fail('No images expected'),{expectedCount:3});
    assert.equal(cbt.questions.length,1); assert.equal(theory.questions.length,2);
    assert.equal(theory.questions[1].type,'theory'); assert.equal(theory.questions[1].originalType,'short_answer');
    assert.equal(theory.questions[1].sourceBank,'lecture'); assert.equal(theory.questions[1].correct,null);
    assert.equal(cbt.questions[0].subject,'Financial Accounting'); assert.equal(cbt.questions[0].sourceSubject,'Accounts');
    assert.deepEqual(theory.questions[0].hierarchy,row.hierarchy); assert.equal(cbt.questions[0].correct,1);
    assert.deepEqual(row.year,2025); assert.equal(theory.exam.name,'WAEC Theory');
  });
  it('preserves diagrams inside question, supplied answer and marking scheme', () => {
    const data=Buffer.from('original-image'),hash=crypto.createHash('sha256').update(data).digest('hex'),html=`<img src="assets/${hash}.png">`;
    const [cbt,theory]=buildWaecCollections([{...row,type:'theory',options:[],optionsHtml:[],correct:null,questionHtml:html,answerHtml:html,explanationHtml:html}],()=>({mime:'image/png',data:data.toString('base64')}),{expectedCount:1});
    assert.equal(cbt.questions.length,0); assert.equal(theory.sourceAudit.imageReferences,3); assert.equal(theory.sourceAudit.uniqueImages,1);
    assert.equal(theory.questions[0].answerHtml,`<img src="pastq-asset:${hash}">`);
  });
  it('refuses incomplete exports and duplicate identities while retaining unanswered source records', () => {
    assert.throws(()=>buildWaecCollections([row],()=>null,{expectedCount:2}),/Incomplete/);
    assert.throws(()=>buildWaecCollections([row,row],()=>null,{expectedCount:2}),/duplicate/);
    const [,theory]=buildWaecCollections([{...row,type:'theory',correct:null,options:[],optionsHtml:[]}],()=>null,{expectedCount:1});
    assert.equal(theory.questions.length,1); assert.equal(theory.sourceAudit.recordsWithoutSuppliedAnswer,1);
  });
  it('retains a question with an empty source image and flags the unavailable diagram', () => {
    const hash=crypto.createHash('sha256').update('').digest('hex');
    const [cbt]=buildWaecCollections([{...row,explanationHtml:`<img src="assets/${hash}.png">`}],()=>({mime:'image/png',data:'',unavailable:'empty_source_image'}),{expectedCount:1});
    assert.equal(cbt.questions.length,1);assert.equal(cbt.sourceAudit.sourceImageReferences,1);assert.equal(cbt.sourceAudit.imageReferences,0);
    assert.equal(cbt.questions[0].missingAssets[0].reason,'empty_source_image');assert.match(cbt.questions[0].explanationHtml,/Source diagram unavailable/);
  });
});
