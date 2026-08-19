import "dotenv/config";
import { config } from "./config.js";
import {
  initializeStorage,
  resumeIncompleteJobsOnBoot,
  pollAndRunQueuedJobs
} from "./jobRunner.js";

async function main() {
  await initializeStorage();

  // If the previous run was interrupted, resume whatever is still pending/processing.
  if (config.jobProcessorEnabled) {
    await resumeIncompleteJobsOnBoot();
  }

  // Keep the event loop alive and periodically start queued jobs.
  const intervalMs = Math.max(1000, config.jobPollIntervalMs);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (config.jobProcessorEnabled) {
        await pollAndRunQueuedJobs();
      }
    } catch (e) {
      console.error("Worker loop error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main();

