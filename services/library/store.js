/** Hostinger filesystem library: evidence-gated taxonomy catalog + bundle JSON. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { gzipSync } from 'node:zlib';
import { normalizeText } from '../vision/educationTaxonomy.js';
import { reviewQuestions } from '../vision/reviewedMaterials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function libraryDir() {
  if (process.env.PASTQ_LIBRARY_DIR) return path.resolve(process.env.PASTQ_LIBRARY_DIR);
  const dataRoot = process.env.DATA_DIR || process.env.PASTQ_DATA_DIR;
  return dataRoot ? path.join(path.resolve(dataRoot), 'library') : path.join(__dirname, '../../data/library');
}
function bundlesDir() { return path.join(libraryDir(), 'bundles'); }
function catalogFile() { return path.join(libraryDir(), 'catalog.json'); }
function aliasesFile() { return path.join(libraryDir(), 'aliases.json'); }
function summariesDir() { return path.join(libraryDir(), 'summaries'); }
function readAliases() {
  if (!fs.existsSync(aliasesFile())) return {};
  return JSON.parse(fs.readFileSync(aliasesFile(), 'utf8'));
}
function ensureDirs() {
  for (const dir of [libraryDir(), bundlesDir(), summariesDir()]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirs();

function slugify(text) {
  const normalized = normalizeText(text);
  let output = '';
  let separated = false;
  for (const character of normalized) {
    if (character === ' ') { separated = true; continue; }
    if (separated && output) output += '-';
    output += character;
    separated = false;
  }
  return output || 'unclassified';
}

function emptyCatalog() {
  return { schemaVersion: 2, organizations: [], ungrouped: [], universities: [], updatedAt: null };
}

function normalizeCatalog(raw) {
  const catalog = raw && typeof raw === 'object' ? raw : emptyCatalog();
  catalog.schemaVersion = 2;
  catalog.organizations = Array.isArray(catalog.organizations) ? catalog.organizations : [];
  catalog.ungrouped = Array.isArray(catalog.ungrouped) ? catalog.ungrouped : [];
  // Preserve legacy catalogs as read-only organization branches during migration.
  if (!catalog.organizations.length && Array.isArray(catalog.universities)) {
    catalog.organizations = catalog.universities.map((university) => ({
      ...university,
      type: 'university',
      country: university.country || null,
      examTypes: (university.examTypes || []).map((exam) => ({
        ...exam,
        materials: exam.materials || exam.manufacturers || [],
      })),
    }));
  }
  const ungroupedLegacy = [];
  const blockedNames = new Set(['general', 'unknown', 'misc', 'miscellaneous', 'unclassified']);
  catalog.organizations = catalog.organizations.filter((organization) => {
    const blocked = blockedNames.has(normalizeText(organization.name));
    if (blocked) {
      for (const exam of organization.examTypes || []) {
        for (const material of exam.materials || exam.manufacturers || []) {
          ungroupedLegacy.push({
            ...material,
            name: 'Unclassified uploaded material',
            title: material.title || 'Unclassified uploaded material',
            groupingStatus: 'ungrouped',
            reasonCodes: ['legacy_fallback_group_removed'],
            suggestedOrganization: null,
          });
        }
      }
    }
    return !blocked;
  });
  catalog.ungrouped = [...catalog.ungrouped, ...ungroupedLegacy.filter((legacy) => !catalog.ungrouped.some((item) => item.bundleId === legacy.bundleId))];
  catalog.universities = catalog.organizations.filter((organization) => organization.type === 'university');
  return catalog;
}

function readCatalog() {
  ensureDirs();
  if (!fs.existsSync(catalogFile())) return emptyCatalog();
  try { return normalizeCatalog(JSON.parse(fs.readFileSync(catalogFile(), 'utf8'))); }
  catch { return emptyCatalog(); }
}

function writeCatalog(catalog) {
  ensureDirs();
  const normalized = normalizeCatalog(catalog);
  normalized.updatedAt = new Date().toISOString();
  writeAtomic(catalogFile(), normalized);
}

function writeAtomic(file, value) {
  const temp = `${file}.${nanoid()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function bundlePath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid bundle id');
  return path.join(bundlesDir(), `${id}.json`);
}
function resolvedBundlePath(id) {
  const aliases = readAliases();
  const visited = new Set();
  while (Object.hasOwn(aliases, id)) {
    if (visited.has(id) || visited.size > 8) throw new Error('Invalid library alias');
    visited.add(id); id = aliases[id];
  }
  return bundlePath(id);
}
export function getBundle(id) {
  const target = resolvedBundlePath(id);
  if (!fs.existsSync(target)) return null;
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch { return null; }
}
export function saveBundle(bundle) {
  ensureDirs();
  if(bundle.sourceAudit&&Array.isArray(bundle.questions)){
    const references=new Set();let placements=0;
    for(const q of bundle.questions)for(const html of [q.questionHtml,...(q.optionsHtml||[]),q.answerHtml,q.explanationHtml,q.passage])for(const match of String(html||'').matchAll(/pastq-asset:([a-f0-9]{64})/g)){placements++;references.add(match[1]);}
    bundle.sourceAudit={...bundle.sourceAudit,questions:bundle.questions.length,imageReferences:placements,uniqueImages:references.size,reviewedQuestions:bundle.questions.filter(q=>['admin_review','manual_apply'].includes(q.answerSource)).length};
  }
  bundle.updated_at = new Date().toISOString();
  if (!bundle.created_at) bundle.created_at = bundle.updated_at;
  writeAtomic(bundlePath(bundle.id), bundle);
  if (bundle.kind === 'utme-bank' || bundle.kind === 'waec-bank') {
    const target = bundlePath(bundle.id);
    const temp = `${target}.gz.tmp`;
    fs.writeFileSync(temp, gzipSync(fs.readFileSync(target), { level: 6 }));
    fs.renameSync(temp, `${target}.gz`);
    writeAtomic(path.join(summariesDir(), path.basename(target)), {
      ...bundle, questions: undefined, assets: undefined, libraryStats: deriveStats(bundle.questions, bundle.libraryMeta),
    });
  }
  return bundle;
}

export function getBundleDownload(id, acceptGzip = false) {
  const file = resolvedBundlePath(id);
  if (!fs.existsSync(file)) return null;
  const compressed = `${file}.gz`;
  if (acceptGzip && fs.existsSync(compressed) && fs.statSync(compressed).mtimeMs >= fs.statSync(file).mtimeMs) {
    return { file: compressed, encoding: 'gzip' };
  }
  return { file, encoding: null };
}

function letterToIndex(letter) {
  const index = 'ABCDE'.indexOf(String(letter || '').trim().toUpperCase());
  return index >= 0 ? index : null;
}

export function applyAnswersToBundle(bundleId, updates = []) {
  const bundle = getBundle(bundleId);
  if (!bundle) return { ok: false, error: 'Bundle not found' };
  let applied = 0;
  const notFound = [];
  for (const update of updates) {
    let question = update.id != null
      ? (bundle.questions || []).find((item) => String(item.id) === String(update.id)) : null;
    if (!question && update.questionNumber != null) {
      question = (bundle.questions || []).find((item) => Number(item.questionNumber) === Number(update.questionNumber));
    }
    if (!question) { notFound.push(update); continue; }
    let correct=question.correct;
    if(update.correctLetter!=null){correct=letterToIndex(update.correctLetter);if(correct===null)throw Object.assign(new Error('Invalid answer letter'),{status:400});}
    else if(update.correct!=null){const index=typeof update.correct==='string'?letterToIndex(update.correct):null;correct=index??update.correct;}
    const [edited]=reviewQuestions({status:'completed',questions:[question]},[{...question,correct,explanation:update.explanation??question.explanation}]);
    Object.assign(question,edited,{answerSource:'manual_apply'});
    applied += 1;
  }
  saveBundle(bundle);
  return { ok: true, bundleId, applied, notFound, questionCount: (bundle.questions || []).length };
}

export function listBundles({ summaries = false } = {}) {
  ensureDirs();
  const aliases = readAliases();
  return fs.readdirSync(bundlesDir()).filter((file) => file.endsWith('.json') && !Object.hasOwn(aliases, file.slice(0, -5))).map((file) => {
    try {
      const full = path.join(bundlesDir(), file), summary = path.join(summariesDir(), file);
      const source = summaries && fs.existsSync(summary) && fs.statSync(summary).mtimeMs >= fs.statSync(full).mtimeMs ? summary : full;
      return JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
}

function normalizeQuestionText(question) {
  return normalizeText(question.question || '').slice(0, 300);
}
export function mergeQuestions(existing, incoming) {
  const seen = new Set((existing || []).map(normalizeQuestionText));
  const merged = [...(existing || [])];
  for (const question of incoming || []) {
    const key = normalizeQuestionText(question);
    if (key && key.length >= 15 && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(question);
  }
  return merged;
}

/** Streams come from the model's library classification, not a subject word list. */
function deriveStats(questions, meta = null) {
  const subjects = [...new Set((questions || []).map((question) => question.subject).filter(Boolean))].sort();
  const streams = [...new Set(meta?.streams || [])].sort();
  const years = (questions || []).map((question) => parseInt(String(question.year || ''), 10))
    .filter((year) => Number.isInteger(year) && year > 1900 && year < 2100);
  return {
    subjects, streams, yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null, questionCount: (questions || []).length,
  };
}

function materialSummary(bundle, stats = bundle.libraryStats || deriveStats(bundle.questions, bundle.libraryMeta)) {
  return {
    id: bundle.id, bundleId: bundle.id, title: bundle.title, name: bundle.publisher || bundle.title, icon: bundle.icon || '📚',
    publisher: bundle.publisher || null, groupingStatus: bundle.groupingStatus,
    groupConfidence: bundle.groupConfidence || 0, questionCount: stats.questionCount,
    yearMin: stats.yearMin, yearMax: stats.yearMax, subjects: stats.subjects, streams: stats.streams,
    educationLevel: bundle.educationLevel || null, faculty: bundle.faculty || null,
    department: bundle.department || null, programme: bundle.programme || null,
    courseCode: bundle.courseCode || null, updatedAt: bundle.updated_at,
  };
}

function normalizeLibraryMetaInput(meta = {}) {
  if (meta.taxonomyVersion === 2 || meta.organization) return meta;
  // Compatibility for previously reviewed metadata and admin imports. This is
  // not a classifier fallback: explicit stored fields remain explicit evidence.
  const organizationName = meta.university || null;
  return {
    ...meta,
    taxonomyVersion: 2,
    groupingStatus: organizationName && organizationName !== 'General' ? 'grouped' : 'ungrouped',
    groupConfidence: organizationName && organizationName !== 'General' ? 1 : 0,
    groupKey: organizationName && organizationName !== 'General' ? slugify(organizationName) : null,
    organization: organizationName && organizationName !== 'General'
      ? { id: slugify(organizationName), name: organizationName, shortName: null, type: 'university', country: null, confidence: 1, evidence: ['legacy_reviewed_metadata'] }
      : { id: null, name: null, type: 'other', confidence: 0, evidence: [] },
    exam: { name: meta.examType || null, kind: 'other', confidence: meta.examType ? 1 : 0, evidence: ['legacy_reviewed_metadata'] },
    publisher: { name: meta.manufacturer || null, confidence: meta.manufacturerConfidence || (meta.manufacturer ? 1 : 0), evidence: meta.manufacturer ? ['legacy_reviewed_metadata'] : [] },
  };
}

function findGroupedBundle(catalog, meta) {
  if (meta.groupingStatus !== 'grouped') return null;
  const organization = catalog.organizations.find((item) => item.id === meta.groupKey);
  const examId = slugify(meta.exam?.name || 'materials');
  const exam = organization?.examTypes?.find((item) => item.id === examId);
  const collectionKey = slugify(meta.collectionKey || meta.publisher?.name || meta.exam?.name || 'official-materials');
  const material = exam?.materials?.find((item) => item.collectionKey === collectionKey);
  return material?.bundleId ? getBundle(material.bundleId) : null;
}

function upsertCatalogEntry(catalog, meta, bundle) {
  const stats = deriveStats(bundle.questions, bundle.libraryMeta);
  if (meta.groupingStatus !== 'grouped' || !meta.groupKey || !meta.organization?.name) {
    catalog.ungrouped = (catalog.ungrouped || []).filter((item) => item.bundleId !== bundle.id);
    catalog.ungrouped.push({
      ...materialSummary(bundle, stats),
      reasonCodes: meta.reasonCodes || [],
      suggestedOrganization: meta.organization?.name || null,
    });
    return;
  }

  catalog.ungrouped = (catalog.ungrouped || []).filter((item) => item.bundleId !== bundle.id);
  let organization = catalog.organizations.find((item) => item.id === meta.groupKey);
  if (!organization) {
    organization = {
      id: meta.groupKey, slug: meta.groupKey, name: meta.organization.name,
      shortName: meta.organization.shortName || null, type: meta.organization.type || 'other',
      country: meta.organization.country || null, confidence: meta.organization.confidence,
      examTypes: [],
    };
    catalog.organizations.push(organization);
  }
  const examName = meta.exam?.name || 'Materials';
  const examId = slugify(examName);
  let exam = organization.examTypes.find((item) => item.id === examId);
  if (!exam) {
    exam = { id: examId, slug: examId, name: examName, kind: meta.exam?.kind || 'other', materials: [] };
    organization.examTypes.push(exam);
  }
  const collectionKey = slugify(meta.collectionKey || meta.publisher?.name || examName || 'official-materials');
  const summary = { ...materialSummary(bundle, stats), collectionKey };
  const existingIndex = exam.materials.findIndex((item) => item.collectionKey === collectionKey);
  if (existingIndex >= 0) exam.materials[existingIndex] = summary;
  else exam.materials.push(summary);
  exam.manufacturers = exam.materials; // compatibility with older clients
  organization.examTypes.sort((a, b) => a.name.localeCompare(b.name));
  catalog.organizations.sort((a, b) => a.name.localeCompare(b.name));
}

export function upsertSessionToLibrary(session, libraryMeta) {
  libraryMeta = normalizeLibraryMetaInput(libraryMeta);
  const catalog = readCatalog();
  let bundle = findGroupedBundle(catalog, libraryMeta);
  if (!bundle) {
    const organizationLabel = libraryMeta.organization?.shortName || libraryMeta.organization?.name;
    const examLabel = libraryMeta.exam?.name;
    const publisherLabel = libraryMeta.publisher?.name;
    const title = publisherLabel && examLabel ? `${publisherLabel} — ${examLabel}`
      : [organizationLabel, examLabel].filter(Boolean).join(' — ') || session.name || 'Unclassified material';
    bundle = {
      id: nanoid(), title, name: title, icon: session.icon || '📚', status: 'published',
      groupingStatus: libraryMeta.groupingStatus, groupConfidence: libraryMeta.groupConfidence,
      groupKey: libraryMeta.groupKey, organization: libraryMeta.organization, exam: libraryMeta.exam,
      publisher: libraryMeta.publisher?.name || null, educationLevel: libraryMeta.educationLevel,
      faculty: libraryMeta.faculty, department: libraryMeta.department, programme: libraryMeta.programme,
      courseCode: libraryMeta.courseCode, university: libraryMeta.university,
      examType: libraryMeta.examType, manufacturer: libraryMeta.manufacturer,
      libraryMeta, questions: [], groups: [], sourceSessionIds: [],
    };
  }
  bundle.questions = mergeQuestions(bundle.questions, session.questions || []);
  bundle.groups = session.groups || bundle.groups;
  bundle.sourceSessionIds = [...new Set([...(bundle.sourceSessionIds || []), session.id])];
  bundle.question_count = bundle.questions.length;
  bundle.libraryMeta = libraryMeta;
  saveBundle(bundle);
  upsertCatalogEntry(catalog, libraryMeta, bundle);
  writeCatalog(catalog);
  return { bundle, catalog: readCatalog() };
}

export function getCatalog() { return readCatalog(); }

/** Install checked-in content once, preserving answers and catalog edits on restart. */
export function installSeedBundle(seed) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(seed?.id || '') || !Array.isArray(seed.questions)) {
    throw new Error('Invalid seed bundle');
  }
  const catalog = readCatalog();
  const existing = getBundle(seed.id) || findGroupedBundle(catalog, seed.libraryMeta);
  const bundle = existing || saveBundle(structuredClone(seed));
  const listed = catalog.ungrouped.some(item => item.bundleId === bundle.id)
    || catalog.organizations.some(org => (org.examTypes || []).some(exam =>
      (exam.materials || []).some(item => item.bundleId === bundle.id)));
  if (!listed) {
    upsertCatalogEntry(catalog, bundle.libraryMeta, bundle);
    writeCatalog(catalog);
  }
  return { bundle, installed: !existing };
}

function removeBundleFromCatalog(catalog, bundleId) {
  catalog.ungrouped = (catalog.ungrouped || []).filter((item) => item.bundleId !== bundleId);
  for (const organization of catalog.organizations || []) {
    for (const exam of organization.examTypes || []) {
      exam.materials = (exam.materials || exam.manufacturers || []).filter((item) => item.bundleId !== bundleId);
      exam.manufacturers = exam.materials;
    }
    organization.examTypes = (organization.examTypes || []).filter((exam) => exam.materials.length > 0);
  }
  catalog.organizations = (catalog.organizations || []).filter((organization) => organization.examTypes.length > 0);
}

/** Publish one complete collection; keep old files and resolve saved source links to it. */
export function replaceLibraryCollections(bundle, previousIds) {
  if (!Array.isArray(previousIds) || previousIds.includes(bundle.id)) throw new Error('Invalid replaced collections');
  previousIds.forEach(id => bundlePath(id));
  const aliases = readAliases();
  if (aliases[bundle.id]) throw new Error('Canonical bundle cannot be an alias');
  saveBundle(bundle);
  const catalog = readCatalog();
  for (const id of previousIds) removeBundleFromCatalog(catalog, id);
  upsertCatalogEntry(catalog, bundle.libraryMeta, bundle);
  writeCatalog(catalog);
  for (const id of previousIds) aliases[id] = bundle.id;
  writeAtomic(aliasesFile(), aliases);
  return bundle;
}

export function reclassifyBundle(bundleId, input = {}) {
  const bundle = getBundle(bundleId);
  if (!bundle) return { ok: false, error: 'Bundle not found' };
  const name = String(input.organization?.name || '').trim();
  if (!name) return { ok: false, error: 'A reviewed organization name is required' };
  const examName = String(input.exam?.name || '').trim() || null;
  const meta = {
    taxonomyVersion: 2, groupingStatus: 'grouped', groupConfidence: 1,
    groupKey: slugify(input.organization?.id || name),
    organization: {
      id: slugify(input.organization?.id || name), name,
      shortName: String(input.organization?.shortName || '').trim() || null,
      type: String(input.organization?.type || 'other'), country: String(input.organization?.country || '').trim() || null,
      confidence: 1, evidence: ['admin_review'],
    },
    exam: { name: examName, kind: String(input.exam?.kind || 'other'), confidence: examName ? 1 : 0, evidence: examName ? ['admin_review'] : [] },
    publisher: { name: String(input.publisher?.name || '').trim() || null, confidence: input.publisher?.name ? 1 : 0, evidence: input.publisher?.name ? ['admin_review'] : [] },
    educationLevel: input.educationLevel || null, faculty: input.faculty || null, department: input.department || null,
    programme: input.programme || null, courseCode: input.courseCode || null,
    reasonCodes: ['admin_reviewed'], classifiedAt: new Date().toISOString(),
    university: name, examType: examName, manufacturer: input.publisher?.name || null,
  };
  Object.assign(bundle, {
    groupingStatus: 'grouped', groupConfidence: 1, groupKey: meta.groupKey,
    organization: meta.organization, exam: meta.exam, publisher: meta.publisher.name,
    educationLevel: meta.educationLevel, faculty: meta.faculty, department: meta.department,
    programme: meta.programme, courseCode: meta.courseCode, university: name,
    examType: examName, manufacturer: meta.publisher.name, libraryMeta: meta,
  });
  saveBundle(bundle);
  const catalog = readCatalog();
  removeBundleFromCatalog(catalog, bundleId);
  upsertCatalogEntry(catalog, meta, bundle);
  writeCatalog(catalog);
  return { ok: true, bundleId, libraryMeta: meta };
}

export function searchBundles({ query, university, examType, manufacturer, organization, stream } = {}) {
  let bundles = listBundles({ summaries: true });
  const orgFilter = organization || university;
  if (orgFilter) bundles = bundles.filter((bundle) => slugify(bundle.organization?.name || bundle.university) === slugify(orgFilter));
  if (examType) bundles = bundles.filter((bundle) => slugify(bundle.exam?.name || bundle.examType) === slugify(examType));
  if (manufacturer) bundles = bundles.filter((bundle) => slugify(bundle.publisher || bundle.manufacturer) === slugify(manufacturer));
  if (stream) bundles = bundles.filter((bundle) => (bundle.libraryStats || deriveStats(bundle.questions, bundle.libraryMeta)).streams.includes(String(stream).toLowerCase()));
  if (query) {
    const needle = String(query).toLowerCase();
    bundles = bundles.filter((bundle) => [bundle.title, bundle.organization?.name, bundle.exam?.name, bundle.publisher,
      ...((bundle.libraryStats || deriveStats(bundle.questions, bundle.libraryMeta)).subjects || [])].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }
  return bundles.map((bundle) => ({
    ...materialSummary(bundle), title: bundle.title, university: bundle.organization?.name || bundle.university,
    organization: bundle.organization, examType: bundle.exam?.name || bundle.examType,
    manufacturer: bundle.publisher || bundle.manufacturer, question_count: bundle.libraryStats?.questionCount ?? (bundle.questions || []).length,
    updated_at: bundle.updated_at,
  }));
}

export { slugify, deriveStats, libraryDir as LIBRARY_DIR };
