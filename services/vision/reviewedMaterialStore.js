import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let database;
function db() {
  if (database) return database;
  const root = path.resolve(process.env.DATA_DIR || process.env.PASTQ_DATA_DIR || fileURLToPath(new URL('../../data/', import.meta.url)));
  fs.mkdirSync(root, { recursive: true });
  database = new DatabaseSync(path.join(root, 'reviewed-materials.db'));
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reviewed_materials (
      id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, updated_at INTEGER NOT NULL, summary TEXT NOT NULL, material TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviewed_materials_owner ON reviewed_materials(owner_key, updated_at DESC, id);`);
  return database;
}

export function saveReviewedMaterial(ownerKey, material) {
  if (!ownerKey || !material?.id) throw new Error('Missing material owner');
  const { questions, ...summary } = material;
  const result = db().prepare(`INSERT INTO reviewed_materials (id, owner_key, updated_at, summary, material) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, summary=excluded.summary, material=excluded.material
    WHERE reviewed_materials.owner_key=excluded.owner_key`).run(material.id, ownerKey, material.updatedAt, JSON.stringify(summary), JSON.stringify(material));
  if (!result.changes) throw new Error('Material belongs to another account');
  return material;
}

export function getReviewedMaterial(ownerKey, id) {
  const row = db().prepare('SELECT material FROM reviewed_materials WHERE owner_key=? AND id=?').get(ownerKey, id);
  return row ? JSON.parse(row.material) : null;
}

export function listReviewedMaterials(ownerKey, offset, limit) {
  const rows = db().prepare('SELECT summary FROM reviewed_materials WHERE owner_key=? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?').all(ownerKey, limit + 1, offset);
  return { materials: rows.slice(0, limit).map(row => JSON.parse(row.summary)), nextOffset: rows.length > limit ? offset + limit : null };
}

export function deleteReviewedMaterial(id) { db().prepare('DELETE FROM reviewed_materials WHERE id=?').run(id); }
export function closeReviewedMaterials() { database?.close(); database = null; }
