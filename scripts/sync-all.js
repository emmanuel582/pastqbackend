import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { syncAllPendingSessions } from '../services/vision/supabaseSync.js';
import { listSessions } from '../services/vision/store.js';

async function main() {
  console.log("Starting forced sync of all sessions...");
  await syncAllPendingSessions(listSessions);
  console.log("Done.");
}

main().catch(console.error);
