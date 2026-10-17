import crypto from 'node:crypto';

export const UTME_BUNDLE_ID = 'utme-testdriller-2027';
export const UTME_SOURCE_COUNT = 42148;
const subjects = {
  accounts: 'Financial Accounting', 'financial accounting': 'Financial Accounting',
  agriculture: 'Agricultural Science', 'agricultural science': 'Agricultural Science',
  english: 'Use of English', 'the lekki headmaster': 'Use of English',
  literature: 'Literature in English', 'literature-in-english': 'Literature in English',
  'literature textbooks': 'Literature in English',
  crk: 'Christian Religious Studies', crs: 'Christian Religious Studies',
  irk: 'Islamic Religious Studies', irs: 'Islamic Religious Studies',
  phe: 'Physical and Health Education', commerce: 'Commerce', economics: 'Economics',
};
export function utmeSubject(subject) { return subjects[String(subject).trim().toLowerCase()] || String(subject).trim(); }

/** Consolidate source records, never question wording: every original remains a distinct record. */
export function buildUtmeCollection(bundles, { expectedCount = UTME_SOURCE_COUNT } = {}) {
  if (!bundles.length) throw new Error('Source collections required');
  const sourceKeys = new Set();
  const assets = {};
  let imageReferences = 0;
  const questionCounts = {};
  function internImages(html) {
    return String(html || '').replace(/src="(data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+))"/g, (_all, _uri, format, data) => {
      const bytes = Buffer.from(data, 'base64');
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!assets[hash]) assets[hash] = { mime: `image/${format}`, data };
      imageReferences++;
      return `src="pastq-asset:${hash}"`;
    });
  }
  const questions = bundles.flatMap(bundle => bundle.questions.map(original => {
    if (!original.practiceKey || sourceKeys.has(original.practiceKey)) throw new Error('Missing or duplicate source identity');
    sourceKeys.add(original.practiceKey);
    const question = structuredClone(original);
    question.sourceSubject = original.sourceSubject || original.subject;
    question.sourceSet = original.sourceSet || original.paper || original.year || null;
    question.subject = utmeSubject(original.subject);
    const year = String(original.year || '').match(/\b(?:19|20)\d{2}\b/);
    question.year = year?.[0] || null;
    question.questionHtml = internImages(original.questionHtml);
    question.optionsHtml = (original.optionsHtml || []).map(internImages);
    question.explanationHtml = internImages(original.explanationHtml);
    questionCounts[question.subject] = (questionCounts[question.subject] || 0) + 1;
    return question;
  }));
  if (questions.length !== expectedCount) throw new Error(`Incomplete UTME source: ${questions.length}/${expectedCount}`);
  questions.forEach((question, index) => { question.id = index + 1; question.orderIndex = index + 1; });
  const meta = structuredClone(bundles[0].libraryMeta);
  meta.collectionKey = UTME_BUNDLE_ID;
  const bundle = {
    ...structuredClone(bundles[0]), id: UTME_BUNDLE_ID, title: 'UTME', name: 'UTME', kind: 'utme-bank',
    libraryMeta: meta, organization: meta.organization, exam: meta.exam, examType: meta.exam?.name || 'UTME',
    publisher: meta.publisher?.name || null, manufacturer: meta.publisher?.name || null,
    questions, assets, question_count: questions.length, groups: [],
    replacesBundleIds: bundles.map(item => item.id),
    sourceAudit: { questions: questions.length, imageReferences, uniqueImages: Object.keys(assets).length,
      subjects: questionCounts, aiUsed: false, duplicatesRemoved: 0 },
  };
  delete bundle.created_at; delete bundle.updated_at;
  return bundle;
}
