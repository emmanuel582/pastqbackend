import crypto from 'node:crypto';

export const WAEC_SOURCE_COUNT = 53207;
export const WAEC_SOURCE_SHA256 = '820447df1976b783c0a11036611ebccfb4a30fa586e0db1202972fb4ac8f8e40';
const names = { accounts: 'Financial Accounting', 'financial accounting': 'Financial Accounting', 'further maths': 'Further Mathematics', english: 'English Language', literature: 'Literature in English', 'literature textbooks': 'Literature in English', crk: 'Christian Religious Studies', irk: 'Islamic Religious Studies', commerce: 'Commerce', economics: 'Economics' };
const fields = question => [question.questionHtml, ...(question.optionsHtml || []), question.explanationHtml, question.answerHtml];
export function waecSubject(subject) { return names[String(subject).trim().toLowerCase()] || String(subject).trim(); }

/** Every source record belongs to exactly one collection. Answers and hierarchy are never generated. */
export function buildWaecCollections(records, loadAsset, { expectedCount = WAEC_SOURCE_COUNT } = {}) {
  if (records.length !== expectedCount) throw new Error(`Incomplete WAEC export: ${records.length}/${expectedCount}`);
  const seen = new Set();
  const organization = { id: 'waec', name: 'West African Examinations Council', shortName: 'WAEC', type: 'exam_board', country: 'Nigeria', confidence: 1, evidence: ['user_confirmed_import'] };
  const bundles = ['CBT', 'Theory'].map(mode => {
    const id = `waec-${mode.toLowerCase()}-testdriller-2027`, title = `WAEC ${mode}`;
    const exam = { name: title, kind: 'secondary', confidence: 1, evidence: ['user_confirmed_import'] };
    const libraryMeta = { taxonomyVersion: 2, groupingStatus: 'grouped', groupConfidence: 1, groupKey: 'waec', collectionKey: id, organization, exam, publisher: { name: 'TestDriller', confidence: 1, evidence: ['source_attribution'] }, streams: [], educationLevel: 'secondary', reasonCodes: ['direct_structured_import'] };
    return { id, title, name: title, kind: 'waec-bank', studyMode: mode === 'Theory' ? 'theory' : 'cbt', icon: '📚', status: 'published', groupingStatus: 'grouped', groupConfidence: 1, groupKey: 'waec', organization, exam, examType: title, university: organization.name, publisher: 'TestDriller', manufacturer: 'TestDriller', educationLevel: 'secondary', libraryMeta, questions: [], assets: {}, groups: [], sourceSessionIds: [], sourceAudit: { questions: 0, imageReferences: 0, uniqueImages: 0, subjects: {}, originalTypes: {}, aiUsed: false, duplicatesRemoved: 0, answersIndependentlyCorrected: false, sourceSha256: WAEC_SOURCE_SHA256 } };
  });
  for (const original of records) {
    if (!original.practiceKey || seen.has(original.practiceKey) || !['mcq', 'theory', 'short_answer'].includes(original.type)) throw new Error('Invalid or duplicate source identity');
    if (!Array.isArray(original.options) || original.optionsHtml?.length !== original.options.length) throw new Error('Invalid source choices');
    if (original.type === 'mcq' && (original.options.length < 2 || !Number.isInteger(original.correct) || original.correct < 0 || original.correct >= original.options.length)) throw new Error('Invalid supplied MCQ answer');
    seen.add(original.practiceKey);
    const bundle = bundles[original.type === 'mcq' ? 0 : 1];
    const q = structuredClone(original);
    q.originalType = original.type;
    q.sourceSubject = original.subject;
    q.subject = waecSubject(original.subject);
    q.sourceSet = original.paper || (original.year != null ? String(original.year) : null);
    q.year = original.year != null ? String(original.year) : null;
    q.sourceBank = original.bank === 'topic_practice' ? 'lecture' : 'res';
    q.type = original.type === 'mcq' ? 'mcq' : 'theory';
    if (q.type === 'theory') q.correct = null;
    function intern(html, field) {
      return String(html || '').replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (tag, src) => {
        if (!/^assets\/[a-f0-9]{64}\.(?:png|jpe?g|gif|webp)$/i.test(src)) throw new Error(`Unexpected source image: ${src}`);
        const asset = loadAsset(src);
        const key = crypto.createHash('sha256').update(Buffer.from(asset.data, 'base64')).digest('hex');
        if (!src.includes(key)) throw new Error(`Source image checksum mismatch: ${src}`);
        bundle.sourceAudit.sourceImageReferences = (bundle.sourceAudit.sourceImageReferences || 0) + 1;
        if (asset.unavailable) {
          bundle.sourceAudit.unavailableImageReferences = (bundle.sourceAudit.unavailableImageReferences || 0) + 1;
          q.missingAssets = [...(q.missingAssets || []), { file: src, field, reason: asset.unavailable }];
          return '<span>Source diagram unavailable: the supplied image file is empty.</span>';
        }
        bundle.assets[key] = asset;
        bundle.sourceAudit.imageReferences++;
        return tag.replace(src, `pastq-asset:${key}`);
      });
    }
    q.questionHtml = intern(q.questionHtml, 'questionHtml');
    q.optionsHtml = q.optionsHtml.map((html,index) => intern(html, `optionsHtml[${index}]`));
    q.explanationHtml = intern(q.explanationHtml, 'explanationHtml');
    q.answerHtml = intern(q.answerHtml, 'answerHtml');
    bundle.questions.push(q);
    const audit = bundle.sourceAudit;
    audit.subjects[q.subject] = (audit.subjects[q.subject] || 0) + 1;
    audit.originalTypes[original.type] = (audit.originalTypes[original.type] || 0) + 1;
  }
  for (const bundle of bundles) {
    bundle.question_count = bundle.questions.length;
    bundle.sourceAudit.questions = bundle.questions.length;
    bundle.sourceAudit.uniqueImages = Object.keys(bundle.assets).length;
    bundle.sourceAudit.recordsWithoutSuppliedAnswer = bundle.questions.filter(q => q.type === 'theory' && !q.answerText && !q.answerHtml && !q.explanation && !q.explanationHtml).length;
    // Validate every final reference, including answers and marking schemes.
    for (const q of bundle.questions) for (const html of fields(q)) for (const reference of String(html || '').matchAll(/pastq-asset:([a-f0-9]{64})/g)) if (!bundle.assets[reference[1]]) throw new Error('Missing embedded image');
  }
  return bundles;
}
