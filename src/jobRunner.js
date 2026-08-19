import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { extractQuestionsFromImage } from "./openrouter.js";
import {
  ensureDir,
  exists,
  fileSha1,
  readDirSafe,
  readJson,
  writeJsonAtomic
} from "./storage.js";

const jobsDir = path.join(config.dataDir, "jobs");
const libraryFile = path.join(config.dataDir, "library.json");
const runningJobs = new Set();

function nowIso() {
  return new Date().toISOString();
}

function normalizeQuestion(raw, pageIndex, qIndex) {
  return {
    id: `${pageIndex + 1}-${qIndex + 1}`,
    questionNumber: raw.questionNumber || `${qIndex + 1}`,
    question: raw.questionText || "",
    options: Array.isArray(raw.options) ? raw.options : [],
    subject: raw.subject || "Unknown",
    year: raw.year || null,
    paper: raw.paper || null,
    correct: undefined
  };
}

async function getJobPath(jobId) {
  await ensureDir(jobsDir);
  return path.join(jobsDir, `${jobId}.json`);
}

async function loadJob(jobId) {
  const filePath = await getJobPath(jobId);
  return readJson(filePath, null);
}

async function saveJob(job) {
  const filePath = await getJobPath(job.id);
  await writeJsonAtomic(filePath, job);
}

async function addToLibrary(job) {
  const lib = (await readJson(libraryFile, { materials: [] })) || { materials: [] };
  const existing = lib.materials.find((m) => m.id === job.id);
  const material = {
    id: job.id,
    name: job.materialName,
    createdAt: job.createdAt,
    updatedAt: nowIso(),
    status: job.status,
    questionCount: job.questions.length,
    questions: job.questions
  };

  if (existing) {
    Object.assign(existing, material);
  } else {
    lib.materials.unshift(material);
  }

  await writeJsonAtomic(libraryFile, lib);
}

async function processPage(job, page) {
  if (page.status === "completed") return;
  if (page.status === "processing") page.status = "pending";
  if (page.status !== "pending") return;

  page.status = "processing";
  page.startedAt = nowIso();
  await saveJob(job);

  const model = page.attempts > 0 ? config.modelFallback : config.modelPrimary;
  const result = await extractQuestionsFromImage({
    filePath: page.path,
    mimeType: page.mimeType,
    model,
    openRouterApiKey: config.openRouterApiKey,
    baseUrl: config.openRouterBaseUrl,
    appName: config.appName,
    appBaseUrl: config.appBaseUrl,
    pageNumber: page.index + 1,
    totalPages: job.pages.length,
    maxAttempts: config.extractionRetries,
    maxTokens: config.openRouterMaxTokens
  });

  const qualityScore = Number(result.parsed?.quality?.score || 0);
  page.usage = result.usage;
  page.model = model;
  page.quality = {
    score: qualityScore,
    notes: result.parsed?.quality?.notes || ""
  };

  const extracted = Array.isArray(result.parsed?.questions) ? result.parsed.questions : [];
  if (qualityScore < 0.84 && page.attempts < 1) {
    page.attempts += 1;
    page.status = "pending";
    page.error = "Low quality score, retrying with fallback model";
    await saveJob(job);
    return processPage(job, page);
  }

  page.extractedQuestions = extracted;
  page.status = "completed";
  page.completedAt = nowIso();
  page.error = null;
  job.questions = job.pages
    .filter((p) => p.status === "completed")
    .flatMap((p) => p.extractedQuestions.map((q, i) => normalizeQuestion(q, p.index, i)));
  await saveJob(job);
  await addToLibrary(job);
}

export async function initializeStorage() {
  await ensureDir(config.dataDir);
  await ensureDir(jobsDir);
  const hasLib = await exists(libraryFile);
  if (!hasLib) {
    await writeJsonAtomic(libraryFile, { materials: [] });
  }
}

export async function createJob({ materialName, uploadedFiles }) {
  const id = nanoid(16);
  const createdAt = nowIso();
  const pages = [];

  for (let index = 0; index < uploadedFiles.length; index += 1) {
    const file = uploadedFiles[index];
    const checksum = await fileSha1(file.path);
    pages.push({
      id: `${id}-p${index + 1}`,
      index,
      path: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      checksum,
      attempts: 0,
      status: "pending",
      extractedQuestions: [],
      error: null
    });
  }

  const job = {
    id,
    materialName: materialName || "Untitled Material",
    createdAt,
    updatedAt: createdAt,
    status: "queued",
    questions: [],
    pages
  };
  await saveJob(job);
  if (config.jobProcessorEnabled) runJob(id);
  return job;
}

export async function getJob(jobId) {
  return loadJob(jobId);
}

export async function getLibrary() {
  return readJson(libraryFile, { materials: [] });
}

export async function runJob(jobId) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    let job = await loadJob(jobId);
    if (!job) return;

    job.status = "running";
    job.updatedAt = nowIso();
    await saveJob(job);

    for (const page of job.pages) {
      try {
        await processPage(job, page);
        job = (await loadJob(jobId)) || job;
      } catch (error) {
        page.status = "failed";
        page.error = String(error?.message || error);
        await saveJob(job);
      }
    }

    const hasFailed = job.pages.some((p) => p.status === "failed");
    const allDone = job.pages.every((p) => p.status === "completed");
    job.status = allDone ? "completed" : hasFailed ? "completed_with_errors" : "running";
    job.updatedAt = nowIso();
    await saveJob(job);
    await addToLibrary(job);
  } finally {
    runningJobs.delete(jobId);
  }
}

export async function resumeJob(jobId) {
  const job = await loadJob(jobId);
  if (!job) return null;
  for (const page of job.pages) {
    if (page.status === "processing") page.status = "pending";
  }
  job.status = "queued";
  job.updatedAt = nowIso();
  await saveJob(job);
  if (config.jobProcessorEnabled) runJob(jobId);
  return job;
}

export async function resumeIncompleteJobsOnBoot() {
  const entries = await readDirSafe(jobsDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const jobId = entry.replace(/\.json$/, "");
    const job = await loadJob(jobId);
    if (!job) continue;
    const incomplete = job.pages.some((p) => p.status === "pending" || p.status === "processing");
    if (job.status === "queued" || job.status === "running" || incomplete) {
      runJob(jobId);
    }
  }
}

export async function pollAndRunQueuedJobs() {
  const entries = await readDirSafe(jobsDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const jobId = entry.replace(/\.json$/, "");
    if (runningJobs.has(jobId)) continue;
    const job = await loadJob(jobId);
    if (!job) continue;
    const hasWork = job.pages.some((p) => p.status === "pending" || p.status === "processing");
    if (job.status === "queued" || hasWork) {
      runJob(jobId);
    }
  }
}
