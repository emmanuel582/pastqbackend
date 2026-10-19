import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewQuestions } from '../services/vision/reviewedMaterials.js';
const image = '<img src="pastq-asset:' + 'a'.repeat(64) + '">';
const source = { id: 1, type: 'mcq', question: 'Old question', questionHtml: '<p>Old question</p>' + image, options: ['A', 'B'], optionsHtml: ['<b>A</b>' + image, '<b>B</b>'], explanation: 'Old steps', explanationHtml: '<p>Old steps</p>' + image, correct: 0 };
const review = edit => reviewQuestions({status:'completed',questions:[source]}, [{...source,...edit}])[0];
test('plain edits replace stale rich content while preserving diagrams', () => {
  const result = review({question:'New wording <script>', explanation:'New steps'});
  assert.match(result.questionHtml, /New wording &lt;script&gt;/); assert.doesNotMatch(result.questionHtml, /Old question/);
  assert.ok(result.questionHtml.includes(image)); assert.ok(result.explanationHtml.includes(image)); assert.match(result.explanationHtml,/New steps/);
});
test('option reordering follows source diagrams and answer edits update rich answer', () => {
  const result = review({options:['B','A'],correct:1});
  assert.equal(result.optionsHtml[1],source.optionsHtml[0]); assert.equal(result.optionsHtml[0],source.optionsHtml[1]); assert.equal(result.answerHtml,source.optionsHtml[0]);
});
test('edited diagram-bearing option retains its diagram and updates the unchanged answer index', () => { const result=review({options:['New A','B']});assert.match(result.optionsHtml[0],/New A/);assert.ok(result.optionsHtml[0].includes(image));assert.equal(result.answerText,'New A');assert.equal(result.answerHtml,result.optionsHtml[0]); });
test('all choice aliases require choices and reject out-of-range keys', () => {
  for (const type of ['mcq','single_choice','multiple_choice','true_false',undefined]) {
    assert.throws(()=>reviewQuestions({status:'completed',questions:[{...source,type}]},[{...source,options:[],correct:null}]),/Check the question/);
  }
  assert.throws(()=>review({correct:2}),/Check the question/);
  assert.equal(review({correct:null}).needsReview,true);
});
test('theory has no invented choice answer or auto-mark',()=>{
  const q={...source,type:'theory',options:[],correct:null}; const [result]=reviewQuestions({status:'completed',questions:[q]},[q]);assert.equal(result.correct,null);assert.equal(result.options.length,0);
});
test('edits imported numeric years and written source answers without stale rich text',()=>{
  const q={...source,year:2013,type:'theory',options:[],correct:null,answerText:'Old answer',answerHtml:'<p>Old answer</p>'+image};
  const [result]=reviewQuestions({status:'completed',questions:[q]},[{...q,answerText:'Reviewed answer'}]);
  assert.equal(result.year,2013);assert.match(result.answerHtml,/Reviewed answer/);assert.ok(result.answerHtml.includes(image));
});
