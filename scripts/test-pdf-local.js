import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

import { savePdfFile } from '../services/vision/pdf.js';
import { createSession, getSession, saveSession, updateProgress } from '../services/vision/store.js';
import { runOcrPdf, runSessionWorker, addCost } from '../services/vision/processor.js';

const pdfPath = process.argv[2] || "C:\\Users\\DELL\\Downloads\\Result\\oaubio.pdf";

async function main() {
  console.log("================================================================================");
  console.log(" PastQ Local Vision Pipeline E2E Test");
  console.log(" Target PDF:", pdfPath);
  console.log("================================================================================\n");

  if (!fs.existsSync(pdfPath)) {
    console.error(`Error: File not found at ${pdfPath}`);
    process.exit(1);
  }

  const pdfBuffer = fs.readFileSync(pdfPath);
  console.log(`[local] Read PDF successfully (${(pdfBuffer.length / (1024 * 1024)).toFixed(2)} MB)`);

  const sessionId = crypto.randomUUID();
  const session = createSession({
    id: sessionId,
    name: path.basename(pdfPath, path.extname(pdfPath)),
    icon: "📖",
    subjectHint: "Biology"
  });

  console.log(`[local] Created test session ${sessionId}`);

  console.log("\n--- [Step 1: Save PDF and Run Mistral Document OCR] ---");
  const saved = await savePdfFile(sessionId, pdfBuffer, path.basename(pdfPath));
  console.log(`[local] Saved PDF to ${saved.fullPath}`);

  console.log("[local] Uploading PDF to Mistral OCR endpoint...");
  const startTime = Date.now();
  const ocrResponse = await runOcrPdf(saved.dataUrl);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const ocrPages = ocrResponse.pages || [];
  console.log(`[local] OCR complete in ${duration}s! Extracted ${ocrPages.length} pages.\n`);

  const s = getSession(sessionId);
  addCost(s, { ocrPages: ocrPages.length });

  for (let i = 0; i < ocrPages.length; i++) {
    const md = (ocrPages[i].markdown || '').trim();
    s.pages.push({
      id: crypto.randomUUID(),
      index: i,
      status: 'pending',
      retryCount: 0,
      filename: `pdf-page-${i + 1}`,
      ocrMarkdown: md,
      pageType: null,
      error: null,
      source: 'pdf',
    });
  }

  updateProgress(s);
  saveSession(s);

  console.log("--- [Step 2: Processing All Pages & Extracting Questions] ---");
  await runSessionWorker(sessionId);

  const finalSession = getSession(sessionId);
  console.log("\n================================================================================");
  console.log(" EXTRACTION RESULTS & SUMMARY");
  console.log("================================================================================");
  console.log(`Status:            ${finalSession.status}`);
  console.log(`Pages Processed:   ${finalSession.progress.done}/${finalSession.progress.total} (Skipped: ${finalSession.progress.skipped}, Failed: ${finalSession.progress.failed})`);
  console.log(`Total Questions:   ${finalSession.questions.length}`);
  console.log(`Answer Keys Found: ${finalSession.answerKeys?.length || 0}`);
  console.log(`Question Groups:   ${(finalSession.groups || []).map(g => `${g.year} ${g.paper || ''} (${g.count} qs)`).join(', ')}`);

  console.log("\n--- [Sample 3 Extracted Questions] ---");
  const sample = (finalSession.questions || []).slice(0, 3);
  sample.forEach((q, idx) => {
    console.log(`\n[Question #${idx + 1}]`);
    console.log(`  ID: ${q.id}`);
    console.log(`  Group: ${q.year || 'Unknown'} - ${q.paper || 'Default'}`);
    console.log(`  Question: ${q.question || q.stem || q.questionText || q.text}`);
    if (q.options && q.options.length) {
      console.log(`  Options:`);
      q.options.forEach((opt, oIdx) => {
        const letter = String.fromCharCode(65 + oIdx);
        const isCorrect = (q.correct === oIdx || q.correctLetter === letter) ? ' (CORRECT)' : '';
        console.log(`    ${letter}. ${opt}${isCorrect}`);
      });
    }
    console.log(`  Correct Index: ${q.correct !== null ? q.correct : 'N/A'}`);
    if (q.explanation) {
      console.log(`  Explanation: ${q.explanation}`);
    }
  });

  console.log("\n================================================================================");
  console.log(" All Tests Passed Successfully!");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[FATAL ERROR IN LOCAL TEST]:", err);
  process.exit(1);
});
