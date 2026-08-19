import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
  override: true
});

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const testImagePath = process.env.TEST_IMAGE_PATH || "";
const key = process.env.OPENROUTER_API_KEY || "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertServerUp() {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`/health failed with ${res.status}`);
  const body = await res.json();
  if (!body?.ok) throw new Error("/health returned non-ok body");
  console.log("Health check passed.");
}

async function postJob(imagePath) {
  const fileBuffer = await fs.readFile(imagePath);
  const fileName = path.basename(imagePath);
  const mime = /\.(png)$/i.test(fileName)
    ? "image/png"
    : /\.(jpg|jpeg)$/i.test(fileName)
      ? "image/jpeg"
      : "image/png";

  const form = new FormData();
  form.append("materialName", `E2E Test ${Date.now()}`);
  form.append("files", new Blob([fileBuffer], { type: mime }), fileName);

  const res = await fetch(`${baseUrl}/api/extraction/jobs`, {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`job creation failed ${res.status}: ${text}`);
  }
  const body = await res.json();
  const jobId = body?.job?.id;
  if (!jobId) throw new Error("Missing job id in response");
  return jobId;
}

async function pollJob(jobId) {
  const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 240000);
  const started = Date.now();
  // completed_with_errors is considered a valid terminal state for persistence checks.
  const terminal = new Set(["completed", "completed_with_errors", "failed"]);

  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${baseUrl}/api/extraction/jobs/${jobId}`);
    if (!res.ok) throw new Error(`job fetch failed ${res.status}`);
    const body = await res.json();
    const job = body?.job;
    if (!job) throw new Error("job response missing job object");
    if (terminal.has(job.status)) return job;
    await sleep(2500);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function assertLibraryContains(job) {
  const res = await fetch(`${baseUrl}/api/library`);
  if (!res.ok) throw new Error(`/api/library failed with ${res.status}`);
  const library = await res.json();
  const material = (library?.materials || []).find((m) => m.id === job.id);
  if (!material) throw new Error("Saved material not found in library");

  if ((material.questionCount || 0) !== (job.questions || []).length) {
    throw new Error("Library questionCount does not match job.questions length");
  }

  for (const q of material.questions || []) {
    if (!q?.question || !Array.isArray(q?.options) || q.options.length < 2) {
      throw new Error(`Invalid question shape detected in library: ${JSON.stringify(q)}`);
    }
    if ("correct" in q && q.correct !== undefined && q.correct !== null) {
      throw new Error("Question includes answer key; expected extraction-only output");
    }
  }
}

async function main() {
  if (!key) {
    throw new Error("OPENROUTER_API_KEY missing in server/.env");
  }
  if (!testImagePath) {
    throw new Error("TEST_IMAGE_PATH is required (set env to a local image path)");
  }

  await assertServerUp();
  const jobId = await postJob(testImagePath);
  console.log(`Job created: ${jobId}`);
  const job = await pollJob(jobId);
  console.log(`Job status: ${job.status}, questions: ${(job.questions || []).length}`);
  await assertLibraryContains(job);
  console.log("E2E OK: extraction job saved consistently to library.");
}

main().catch((err) => {
  console.error("E2E FAILED:", err.message || err);
  process.exit(1);
});

