/**
 * Library classification by the model.
 *
 * Materials are shelved by the subject the model reads from the document's
 * outline and question labels — never by exam board or institution. Subject
 * spellings are canonicalised by the model, not by a word list. Each uploaded
 * document stays its own material on that shelf.
 */
import { TAXONOMY_VERSION, normalizeText } from './educationTaxonomy.js';
import { LIBRARY_PROMPT, librarySchema } from './visionPrompts.js';
import { askValidated, validateLibrary } from './contract.js';
import { resolveVisionModel } from './modelRegistry.js';

function slug(value) {
  return normalizeText(value).split(' ').filter(Boolean).join('-');
}

export async function classifyLibrarySession(session) {
  if (session.libraryMeta?.taxonomyVersion === TAXONOMY_VERSION) return session.libraryMeta;
  const model = await resolveVisionModel();
  const counts = new Map();
  for (const q of session.questions || []) if (q.subject) counts.set(q.subject, (counts.get(q.subject) || 0) + 1);
  const subjectLabels = [...counts.keys()];
  const outline = (session.outline?.sections || []).map((s) => ({ title: s.title, kind: s.kind, topic: s.topic, subject: s.subject, year: s.year }));

  const { data } = await askValidated({
    messages: [
      { role: 'system', content: LIBRARY_PROMPT },
      { role: 'user', content: JSON.stringify({ documentTitle: session.outline?.documentTitle || null, organizedBy: session.outline?.organizedBy || null, outline, subjectLabelCounts: Object.fromEntries(counts) }) },
    ],
    schema: librarySchema({ subjectLabels }),
    schemaName: 'library_classification',
    validate: (r) => validateLibrary(r, { subjectLabels }),
    model,
  });

  const canonical = Object.fromEntries(data.canonicalSubjects.map((s) => [s.label, s.canonical.trim()]));
  const group = data.catalogGroup.trim();
  const title = session.outline?.documentTitle || session.name;
  return {
    taxonomyVersion: TAXONOMY_VERSION,
    groupingStatus: 'grouped',
    groupConfidence: 1,
    groupKey: slug(group),
    // The catalog's top level is the subject shelf; `organization` stays the
    // field name for API compatibility.
    organization: { id: slug(group), name: group, shortName: null, type: 'subject', country: null, confidence: 1, evidence: ['model_classification'] },
    exam: { name: 'Past questions', kind: 'other', confidence: 1, evidence: [] },
    publisher: { name: title, confidence: 1, evidence: ['document_title'] },
    organizedBy: session.outline?.organizedBy || null,
    canonicalSubjects: canonical,
    subjects: [...new Set(Object.values(canonical))],
    streams: [...new Set(data.streams.map((s) => s.trim().toLowerCase()).filter(Boolean))],
    educationLevel: data.educationLevel,
    faculty: null, department: null, programme: null, courseCode: null,
    reasonCodes: [],
    classifiedAt: new Date().toISOString(),
    // Compatibility fields for existing API consumers.
    university: group,
    examType: 'Past questions',
    manufacturer: title,
    manufacturerConfidence: 1,
    manufacturerSource: 'document_title',
  };
}

export function manufacturerKey(meta) {
  return [meta.groupKey || meta.organization?.id || meta.organization?.name || meta.university, meta.exam?.name || meta.examType, meta.publisher?.name || meta.manufacturer]
    .map(slug).join('::');
}
