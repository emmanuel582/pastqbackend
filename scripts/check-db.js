import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const supabase = createClient(url, key);

async function checkDb() {
  const { data, error } = await supabase.from('library_bundles').select('*').eq('title', 'oaubio');
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Found rows:", data.length);
    if (data.length > 0) {
      const row = data[0];
      console.log("Columns:", Object.keys(row));
      console.log("Questions length:", row.questions ? row.questions.length : "null/undefined");
      console.log("Question count:", row.question_count);
      console.log("ID:", row.id);
    }
  }
}
checkDb();
