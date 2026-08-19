import "dotenv/config";
import path from "node:path";
import express from "express";
import cors from "cors";
import multer from "multer";
import { config } from "./config.js";
import {
  createJob,
  getJob,
  getLibrary,
  initializeStorage,
  resumeIncompleteJobsOnBoot,
  resumeJob
} from "./jobRunner.js";
import { ensureDir } from "./storage.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const uploadsDir = path.join(config.dataDir, "uploads");
await ensureDir(uploadsDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await ensureDir(uploadsDir);
      cb(null, uploadsDir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    }
  }),
  limits: {
    fileSize: config.maxUploadFileMb * 1024 * 1024,
    files: config.maxUploadFiles
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    dataDir: config.dataDir,
    modelPrimary: config.modelPrimary,
    modelFallback: config.modelFallback
  });
});

app.post("/api/extraction/jobs", upload.array("files"), async (req, res) => {
  try {
    const files = req.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Upload at least one image file in 'files'." });
    }
    const job = await createJob({
      materialName: req.body?.materialName,
      uploadedFiles: files
    });
    return res.status(201).json({ job });
  } catch (error) {
    return res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/extraction/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

app.post("/api/extraction/jobs/:id/resume", async (req, res) => {
  const job = await resumeJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job });
});

app.get("/api/library", async (_req, res) => {
  const library = await getLibrary();
  return res.json(library);
});

await initializeStorage();
if (config.jobProcessorEnabled) {
  await resumeIncompleteJobsOnBoot();
}

app.listen(config.port, "0.0.0.0", () => {
  console.log(`PastQ extraction server listening on :${config.port}`);
  console.log(`Data dir: ${config.dataDir}`);
});
