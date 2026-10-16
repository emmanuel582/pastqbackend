import fs from 'fs';
import path from 'path';
import { getDataRoot } from '../vision/store.js';

const STATS_FILE = path.join(getDataRoot(), 'recommendation-question-stats.json');

function readStats() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeStats(stats) {
  const temp = `${STATS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stats));
  fs.renameSync(temp, STATS_FILE);
}

/** Stores anonymous cohort totals only: no user id, answer selection, or content. */
export function recordAttemptSummary(attempts) {
  const stats = readStats();
  const now = new Date().toISOString();
  for (const attempt of attempts) {
    if (attempt.isCorrect == null) continue;
    const current = stats[attempt.questionKey] || { attempts: 0, correct: 0, updatedAt: now };
    current.attempts += 1;
    current.correct += attempt.isCorrect ? 1 : 0;
    current.updatedAt = now;
    stats[attempt.questionKey] = current;
  }
  writeStats(stats);
}

export function getQuestionStats(questionKeys) {
  const stats = readStats();
  return questionKeys.reduce((result, key) => {
    const value = stats[key];
    if (value) result[key] = value;
    return result;
  }, {});
}
