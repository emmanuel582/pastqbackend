import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewQuestions, reviewedMaterial } from '../services/vision/reviewedMaterials.js';
import { saveReviewedMaterial, getReviewedMaterial, listReviewedMaterials, deleteReviewedMaterial, closeReviewedMaterials } from '../services/vision/reviewedMaterialStore.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pastq-reviewed-'));
process.env.DATA_DIR = temp;
after(() => { closeReviewedMaterials(); delete process.env.DATA_DIR; fs.rmSync(temp, { recursive: true, force: true }); });
const question = { id: 1, subject: 'Biology', question: 'What is a cell?', options: ['One', 'Two'], correct: 1, figures: [{ url: '/safe-source.jpg' }] };
const session = { id: 'upload-one', name: 'My paper', status: 'completed', questions: [question], updatedAt: 100, approvedAt: '2026-10-16T00:00:00Z' };

test('saves reviewed corrections and source figures, ignoring browser provenance', () => {
  const result = reviewQuestions(session, [{ ...question, question: 'Edited question?', correct: 0, figures: [{ url: 'file:///etc/passwd' }] }]);
  assert.equal(result[0].question, 'Edited question?'); assert.equal(result[0].correctLetter, 'A');
  assert.deepEqual(result[0].figures, question.figures); assert.equal(result[0].needsReview, false);
});
test('rejects partial, duplicate, malformed and out-of-range saves', () => {
  for (const incoming of [[], [{ ...question, id: 99 }], [{ ...question, correct: 8 }], [{ ...question, options: [''] }], [{ ...question, subject: {} }]]) {
    assert.throws(() => reviewQuestions(session, incoming), error => error.status === 400);
  }
  assert.throws(() => reviewQuestions({ ...session, status: 'processing' }, [question]), error => error.status === 409);
});
test('database saves survive restart, isolate accounts and retry without duplicates', () => {
  const material = reviewedMaterial({ ...session, questions: reviewQuestions(session, [{ ...question, question: 'A corrected question?' }]) });
  saveReviewedMaterial('owner-a', material); saveReviewedMaterial('owner-a', material);
  closeReviewedMaterials();
  assert.equal(getReviewedMaterial('owner-a', material.id).questions[0].question, 'A corrected question?');
  assert.equal(getReviewedMaterial('owner-b', material.id), null);
  assert.throws(() => saveReviewedMaterial('owner-b', material));
  const list = listReviewedMaterials('owner-a', 0, 50);
  assert.equal(list.materials.length, 1); assert.equal(list.materials[0].questions, undefined);
  assert.deepEqual(listReviewedMaterials('owner-b', 0, 50).materials, []);
  saveReviewedMaterial('owner-a', { ...material, id: 'upload-two', updatedAt: 200 });
  assert.equal(listReviewedMaterials('owner-a', 0, 1).nextOffset, 1);
  assert.equal(listReviewedMaterials('owner-a', 1, 1).materials[0].id, 'upload-one');
  deleteReviewedMaterial(material.id); assert.equal(getReviewedMaterial('owner-a', material.id), null);
});
