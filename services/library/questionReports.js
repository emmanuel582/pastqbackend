import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { getDataRoot } from '../vision/store.js';
let database;
function db() {
  if (database) return database;
  fs.mkdirSync(getDataRoot(),{recursive:true});
  database=new DatabaseSync(path.join(getDataRoot(),'question-reports.db'));
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reports (id TEXT NOT NULL, owner TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id));');
  return database;
}
export function saveReport(owner,input,reference) {
  const old=db().prepare('SELECT data FROM reports WHERE owner=? AND id=?').get(owner,input.id);
  if (old) return JSON.parse(old.data);
  const at=new Date().toISOString(), item={id:input.id,bundleId:input.bundleId,questionId:input.questionId,version:input.version||null,category:input.category,note:input.note||'',subject:reference.subject,year:reference.year||'',status:'received',createdAt:at,updatedAt:at,resolution:'',correctedVersion:null};
  db().prepare('INSERT INTO reports VALUES (?,?,?,?,?)').run(item.id,owner,at,at,JSON.stringify(item)); return item;
}
export function listReports(owner,all=false) {
  const rows=all?db().prepare('SELECT owner,data FROM reports ORDER BY updated_at DESC LIMIT 500').all():db().prepare('SELECT data FROM reports WHERE owner=? ORDER BY updated_at DESC LIMIT 200').all(owner);
  return rows.map(row=>({...JSON.parse(row.data),...(all?{owner:row.owner}:{})}));
}
export function resolveReport(owner,id,changes) {
  const row=db().prepare('SELECT data FROM reports WHERE owner=? AND id=?').get(owner,id);if (!row) return null;
  const item={...JSON.parse(row.data),...changes,updatedAt:new Date().toISOString()};
  db().prepare('UPDATE reports SET updated_at=?,data=? WHERE owner=? AND id=?').run(item.updatedAt,JSON.stringify(item),owner,id);return item;
}
export function closeQuestionReports(){database?.close();database=undefined;}
