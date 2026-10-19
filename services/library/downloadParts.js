import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { getDataRoot } from '../vision/store.js';

const manifests = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
export function partitionBundle(bundle) {
  const version = bundle.updated_at || bundle.updatedAt || 'original';
  const cacheKey = `${bundle.id}:${version}`;
  if (manifests.has(cacheKey)) return manifests.get(cacheKey);
  const grouped = new Map(), parts = [];
  for (const question of bundle.questions || []) {
    const key = JSON.stringify([question.subject || 'General', String(question.year || ''), question.sourceSet || question.paper || '']);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(question);
  }
  const dir = path.join(getDataRoot(), 'library', 'download-parts', bundle.id);
  fs.mkdirSync(dir, {recursive:true});
  for (const [group, questions] of grouped) {let part=0;for (let offset = 0; offset < questions.length;) {
    function payload(count){
      const selected=questions.slice(offset,offset+count),assets={};
      for(const question of selected){const html=[question.questionHtml,...(question.optionsHtml||[]),question.explanationHtml,question.answerHtml,question.passage].join(' ');for(const match of html.matchAll(/pastq-asset:([a-f0-9]{64})/g))if(bundle.assets?.[match[1]])assets[match[1]]=bundle.assets[match[1]];}
      return {selected,body:JSON.stringify({questions:selected,assets})};
    }
    let count=Math.min(100,questions.length-offset),value=payload(count);
    while(Buffer.byteLength(value.body)>8*1024*1024&&count>1){count=Math.max(1,Math.floor(count/2));value=payload(count);}
    const {selected,body}=value,digest = hash(body), file = path.join(dir, digest + '.json');
    if (!fs.existsSync(file)) { const temp = file + '.tmp'; fs.writeFileSync(temp,body); fs.renameSync(temp,file); }
    if (!fs.existsSync(file+'.gz')) {const temp=file+'.gz.tmp';fs.writeFileSync(temp,gzipSync(body,{level:6}));fs.renameSync(temp,file+'.gz');}
    const [subject,year,paper] = JSON.parse(group);
    parts.push({hash:digest,subject,year,paper,count:selected.length,bytes:Buffer.byteLength(body),offset,part:++part});
    offset+=selected.length;
  }}
  const {questions,assets,...metadata} = bundle;
  const result = {version,bundle:metadata,parts,totalQuestions:questions.length,totalBytes:parts.reduce((n,p)=>n+p.bytes,0)};
  manifests.set(cacheKey,result);if(manifests.size>6)manifests.delete(manifests.keys().next().value);
  return result;
}
export function partFile(id, digest) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest)) return null;
  const file = path.join(getDataRoot(),'library','download-parts',id,digest+'.json');
  return fs.existsSync(file) ? file : null;
}
export function partDownload(id,digest,acceptGzip){const file=partFile(id,digest);if(!file)return null;return acceptGzip&&fs.existsSync(file+'.gz')?{file:file+'.gz',encoding:'gzip'}:{file,encoding:null};}
