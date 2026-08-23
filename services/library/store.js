/**
 * Filesystem library store — catalog tree + bundle JSON on server VPS (Render/pxxl.app).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function libraryDir() {
  return process.env.PASTQ_LIBRARY_DIR || path.join(__dirname, '../../data/library');
}

function bundlesDir() {
  return path.join(libraryDir(), 'bundles');
}

function catalogFile() {
  return path.join(libraryDir(), 'catalog.json');
}

function ensureDirs() {
  for (const dir of [libraryDir(), bundlesDir()]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirs();

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function readCatalog() {
  ensureDirs();
  const file = catalogFile();
  if (!fs.existsSync(file)) {
    return { universities: [], updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { universities: [], updatedAt: null };
  }
}

function writeCatalog(catalog) {
  ensureDirs();
  catalog.updatedAt = new Date().toISOString();
  fs.writeFileSync(catalogFile(), JSON.stringify(catalog, null, 2));
}

function bundlePath(id) {
  return path.join(bundlesDir(), `${id}.json`);
}

export function getBundle(id) {
  const p = bundlePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBundle(bundle) {
  bundle.updated_at = new Date().toISOString();
  if (!bundle.created_at) bundle.created_at = bundle.updated_at;
  fs.writeFileSync(bundlePath(bundle.id), JSON.stringify(bundle, null, 2));
  return bundle;
}

export function listBundles() {
  ensureDirs();
  const dir = bundlesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
}

function normalizeQuestionText(q) {
  return String(q.question || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function mergeQuestions(existing, incoming) {
  const seen = new Set((existing || []).map(normalizeQuestionText));
  const merged = [...(existing || [])];
  for (const q of incoming || []) {
    const key = normalizeQuestionText(q);
    if (!key || key.length < 15) {
      merged.push(q);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(q);
  }
  return merged;
}

function deriveStats(questions) {
  const subjects = [...new Set((questions || []).map((q) => q.subject).filter(Boolean))].sort();
  const years = (questions || [])
    .map((q) => parseInt(String(q.year || ''), 10))
    .filter((y) => !Number.isNaN(y) && y > 1980 && y < 2100);
  return {
    subjects,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    questionCount: (questions || []).length,
  };
}

function findManufacturerEntry(catalog, meta) {
  const uniSlug = slugify(meta.university);
  const examSlug = slugify(meta.examType);
  const mfgSlug = slugify(meta.manufacturer);

  for (const uni of catalog.universities) {
    if (uni.slug !== uniSlug) continue;
    for (const exam of uni.examTypes || []) {
      if (exam.slug !== examSlug) continue;
      for (const mfg of exam.manufacturers || []) {
        if (mfg.slug === mfgSlug) return { uni, exam, mfg };
      }
    }
  }
  return null;
}

function upsertCatalogEntry(catalog, meta, bundleId, stats) {
  const uniSlug = slugify(meta.university);
  const examSlug = slugify(meta.examType);
  const mfgSlug = slugify(meta.manufacturer);

  let uni = catalog.universities.find((u) => u.slug === uniSlug);
  if (!uni) {
    uni = { id: uniSlug, slug: uniSlug, name: meta.university, examTypes: [] };
    catalog.universities.push(uni);
  }
  uni.name = meta.university;

  let exam = (uni.examTypes || []).find((e) => e.slug === examSlug);
  if (!exam) {
    exam = { id: examSlug, slug: examSlug, name: meta.examType, manufacturers: [] };
    uni.examTypes = uni.examTypes || [];
    uni.examTypes.push(exam);
  }
  exam.name = meta.examType;

  let mfg = (exam.manufacturers || []).find((m) => m.slug === mfgSlug);
  if (!mfg) {
    mfg = {
      id: mfgSlug,
      slug: mfgSlug,
      name: meta.manufacturer,
      bundleId,
      manufacturerSource: meta.manufacturerSource,
      yearMin: stats.yearMin,
      yearMax: stats.yearMax,
      questionCount: stats.questionCount,
      subjects: stats.subjects,
    };
    exam.manufacturers = exam.manufacturers || [];
    exam.manufacturers.push(mfg);
  } else {
    mfg.bundleId = bundleId;
    mfg.name = meta.manufacturer;
    mfg.manufacturerSource = meta.manufacturerSource;
    mfg.yearMin = stats.yearMin ?? mfg.yearMin;
    mfg.yearMax = stats.yearMax ?? mfg.yearMax;
    mfg.questionCount = stats.questionCount;
    mfg.subjects = stats.subjects;
  }

  catalog.universities.sort((a, b) => a.name.localeCompare(b.name));
  return mfg;
}

/**
 * Upsert session into library — merge same manufacturer, keep siblings separate.
 */
export function upsertSessionToLibrary(session, libraryMeta) {
  const catalog = readCatalog();
  const existing = findManufacturerEntry(catalog, libraryMeta);

  let bundle;
  if (existing?.mfg?.bundleId) {
    bundle = getBundle(existing.mfg.bundleId);
  }

  if (!bundle) {
    bundle = {
      id: nanoid(),
      title: `${libraryMeta.manufacturer} — ${libraryMeta.examType}`,
      name: libraryMeta.manufacturer,
      icon: session.icon || '📚',
      status: 'published',
      university: libraryMeta.university,
      examType: libraryMeta.examType,
      manufacturer: libraryMeta.manufacturer,
      manufacturerSource: libraryMeta.manufacturerSource,
      manufacturerConfidence: libraryMeta.manufacturerConfidence,
      libraryMeta,
      questions: [],
      groups: [],
      sourceSessionIds: [],
    };
  }

  bundle.questions = mergeQuestions(bundle.questions, session.questions || []);
  bundle.groups = session.groups || bundle.groups;
  bundle.sourceSessionIds = [...new Set([...(bundle.sourceSessionIds || []), session.id])];
  bundle.question_count = bundle.questions.length;
  bundle.libraryMeta = libraryMeta;
  bundle.updated_at = new Date().toISOString();

  saveBundle(bundle);

  const stats = deriveStats(bundle.questions);
  upsertCatalogEntry(catalog, libraryMeta, bundle.id, stats);
  writeCatalog(catalog);

  return { bundle, catalog: readCatalog() };
}

export function getCatalog() {
  return readCatalog();
}

export function searchBundles({ query, university, examType, manufacturer } = {}) {
  let bundles = listBundles();
  if (university) {
    bundles = bundles.filter((b) => slugify(b.university) === slugify(university));
  }
  if (examType) {
    bundles = bundles.filter((b) => slugify(b.examType) === slugify(examType));
  }
  if (manufacturer) {
    bundles = bundles.filter((b) => slugify(b.manufacturer) === slugify(manufacturer));
  }
  if (query) {
    const q = query.toLowerCase();
    bundles = bundles.filter(
      (b) =>
        (b.title || '').toLowerCase().includes(q) ||
        (b.manufacturer || '').toLowerCase().includes(q) ||
        (b.university || '').toLowerCase().includes(q)
    );
  }
  return bundles.map((b) => {
    const stats = deriveStats(b.questions);
    return {
      id: b.id,
      title: b.title,
      university: b.university,
      examType: b.examType,
      manufacturer: b.manufacturer,
      manufacturerSource: b.manufacturerSource,
      question_count: b.question_count ?? stats.questionCount,
      subjects: stats.subjects,
      yearMin: stats.yearMin,
      yearMax: stats.yearMax,
      icon: b.icon,
      updated_at: b.updated_at,
    };
  });
}

export { slugify, deriveStats, libraryDir as LIBRARY_DIR };
