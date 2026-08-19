import path from "node:path";

const isRender = Boolean(process.env.RENDER);
const defaultDataDir = isRender ? "/var/data/pastq" : path.resolve(process.cwd(), "data");

export const config = {
  port: Number(process.env.PORT || 3000),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
  appBaseUrl: process.env.APP_BASE_URL || "https://pastq.app",
  appName: process.env.APP_NAME || "PastQ",
  dataDir: process.env.DATA_DIR || defaultDataDir,
  modelPrimary: process.env.GEMINI_MODEL_PRIMARY || "google/gemini-3.1-pro-preview",
  modelFallback: process.env.GEMINI_MODEL_FALLBACK || "google/gemini-3.1-flash-lite",
  extractionRetries: Number(process.env.EXTRACTION_RETRIES || 4),
  maxUploadFiles: Number(process.env.MAX_UPLOAD_FILES || 80),
  maxUploadFileMb: Number(process.env.MAX_UPLOAD_FILE_MB || 12),
  jobProcessorEnabled: process.env.JOB_PROCESSOR_ENABLED === "true",
  jobPollIntervalMs: Number(process.env.JOB_POLL_INTERVAL_MS || 5000),
  openRouterMaxTokens: Number(process.env.OPENROUTER_MAX_TOKENS || 3200)
};
