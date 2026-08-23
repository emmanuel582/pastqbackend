cd C:\Users\DELL\PastQ\server
@'
import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { createSession, getSession, saveSession, updateProgress } from "./services/vision/store.js";
import { savePageImage } from "./services/vision/image.js";
import { runSessionWorker } from "./services/vision/processor.js";

const imgPath = "C:/Users/DELL/Downloads/Result/PHOTO-2026-08-20-20-26-04.jpg";
const buf = fs.readFileSync(imgPath);
const sessionId = crypto.randomUUID();
const session = createSession({ id: sessionId, name: "photo-test", icon: "photo" });
const saved = await savePageImage(sessionId, 0, buf);
session.pages.push({
  id: crypto.randomUUID(),
  index: 0,
  status: "pending",
  retryCount: 0,
  filename: path.basename(imgPath),
  imagePath: saved.fullPath,
  dataUrl: saved.dataUrl,
  pageType: null,
  error: null,
});
session.status = "processing";
updateProgress(session);
saveSession(session);
console.log("[local] session", sessionId);
await runSessionWorker(sessionId);

const final = getSession(sessionId);
console.log("\n=== RESULT ===");
console.log("status:", final?.status);
console.log("questions:", final?.questions?.length);
console.log("groups:", final?.groups?.length);
for (const q of final?.questions || []) {
  console.log(`\nQ${q.questionNumber}: ${(q.question || "").slice(0, 160)}`);
  console.log("  options:", (q.options || []).filter(Boolean).length, "| year:", q.year, "| paper:", q.paper);
}
'@ | Out-File -Encoding utf8 test-photo.mjs

node test-photo.mjs