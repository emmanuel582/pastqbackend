import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(url, key);

async function checkDb() {
  const { data, error } = await supabase.from('practice_sessions').select('id, user_id, status, completed_at').limit(5);
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Student-data rows:", data.length);
    console.log("Columns:", data[0] ? Object.keys(data[0]) : []);
  }
}
checkDb();
