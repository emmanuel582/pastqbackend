/**
 * LOCAL-ONLY live viewer for a vision session — not mounted in production.
 * Polls the real /api/vision/sessions/:id endpoint (same pipeline the app uses)
 * so you can watch a local test run progress in real time without needing the
 * client SPA's Supabase login. Delete this file once you're done testing.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const PET_SPRITE_PATH = path.resolve(__dirname, '../../client/public/pets/hirose/sprite.webp');

router.get('/pet-sprite.webp', (req, res) => {
  res.sendFile(PET_SPRITE_PATH, (err) => {
    if (err) res.status(404).end();
  });
});

router.get('/session/:id', (req, res) => {
  const id = req.params.id;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>PastQ live run — ${id}</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background: #0f1115; color: #e8e6e3; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8a8f98; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1d24; border: 1px solid #2a2e37; border-radius: 10px; padding: 14px; }
  .card .num { font-size: 24px; font-weight: 700; }
  .card .label { font-size: 11px; color: #8a8f98; text-transform: uppercase; letter-spacing: 0.04em; }
  .bar-outer { background: #2a2e37; border-radius: 6px; height: 8px; overflow: hidden; margin-top: 4px; }
  .bar-inner { background: #6ee7b7; height: 100%; transition: width 0.4s; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a2e37; vertical-align: top; }
  th { color: #8a8f98; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .status-done { color: #6ee7b7; } .status-failed { color: #f87171; } .status-processing { color: #fbbf24; }
  .stem { max-width: 480px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #2a2e37; margin-right: 4px; }
  .err { color: #f87171; }
  .header-row { display: flex; align-items: center; gap: 16px; margin-bottom: 4px; }
  #pet {
    width: 192px; height: 208px;
    background-image: url('/debug/pet-sprite.webp');
    background-repeat: no-repeat;
    image-rendering: pixelated;
    transform: scale(0.583);
    transform-origin: top left;
  }
  .pet-wrap { width: 112px; height: 121px; overflow: hidden; flex-shrink: 0; }
</style></head>
<body>
  <div class="header-row">
    <div class="pet-wrap"><div id="pet"></div></div>
    <div>
      <h1 id="name">Loading…</h1>
      <div class="sub">Session <code>${id}</code> · <span id="status">—</span> · updated <span id="ts">—</span></div>
    </div>
  </div>
  <div class="grid" id="stats"></div>
  <h2 style="font-size:14px;color:#8a8f98;">Pages</h2>
  <table id="pages"><thead><tr><th>#</th><th>File</th><th>Status</th><th>Type</th><th>Model</th><th>Error</th></tr></thead><tbody></tbody></table>
  <h2 style="font-size:14px;color:#8a8f98;margin-top:24px;">Extracted questions (<span id="qcount">0</span>)</h2>
  <table id="questions"><thead><tr><th>Subject</th><th>Year</th><th>Question</th></tr></thead><tbody></tbody></table>
<script>
// Same sprite sheet/state map as client/src/app/components/HiroseLoadingPet.tsx
const PET_FRAME = { width: 192, height: 208 };
const PET_STATES = {
  idle: { row: 0, frames: 6, duration: 170 },
  'run-right': { row: 1, frames: 8, duration: 105 },
  'run-left': { row: 2, frames: 8, duration: 105 },
  waving: { row: 3, frames: 4, duration: 170 },
  jumping: { row: 4, frames: 5, duration: 150 },
  failed: { row: 5, frames: 8, duration: 170 },
  waiting: { row: 6, frames: 6, duration: 185 },
  running: { row: 7, frames: 6, duration: 115 },
  review: { row: 8, frames: 6, duration: 190 },
};
// Full moveset while a run is in progress — cycles through every pose, not just one.
const ACTIVE_PLAYLIST = ['run-right', 'jumping', 'waving', 'run-left', 'idle', 'running', 'waiting'];
const HOLD_MS = 2200;
let petState = null;
let petFrame = 0;
let petTimer = null;
let playlistTimer = null;
let playlistIndex = 0;
const petEl = document.getElementById('pet');

function setPetState(name) {
  if (petState === name) return;
  petState = name;
  petFrame = 0;
  if (petTimer) clearInterval(petTimer);
  const cfg = PET_STATES[name];
  const facingLeft = name === 'run-left';
  petEl.style.transform = facingLeft ? 'scale(0.583) scaleX(-1)' : 'scale(0.583)';
  const paint = () => {
    petEl.style.backgroundPosition = \`-\${petFrame * PET_FRAME.width}px -\${cfg.row * PET_FRAME.height}px\`;
  };
  paint();
  petTimer = setInterval(() => {
    petFrame = (petFrame + 1) % cfg.frames;
    paint();
  }, cfg.duration);
}

function playActivePlaylist() {
  if (playlistTimer) return;
  const advance = () => {
    setPetState(ACTIVE_PLAYLIST[playlistIndex % ACTIVE_PLAYLIST.length]);
    playlistIndex++;
  };
  advance();
  playlistTimer = setInterval(advance, HOLD_MS);
}

function stopActivePlaylist() {
  if (playlistTimer) { clearInterval(playlistTimer); playlistTimer = null; }
}
playActivePlaylist();

async function tick() {
  try {
    const res = await fetch('/api/vision/sessions/${id}');
    if (!res.ok) { document.getElementById('status').textContent = 'HTTP ' + res.status; return; }
    const s = await res.json();
    document.getElementById('name').textContent = s.name || 'Untitled';
    document.getElementById('status').textContent = s.status;
    document.getElementById('ts').textContent = new Date().toLocaleTimeString();
    if (s.status === 'completed' || s.status === 'completed_with_errors') {
      stopActivePlaylist();
      setPetState(s.status === 'completed' ? 'jumping' : 'review');
    } else {
      playActivePlaylist();
    }
    const p = s.progress || {};
    const c = s.cost || {};
    document.getElementById('stats').innerHTML = [
      ['Pages done', (p.done||0) + ' / ' + (p.total||0)],
      ['Failed', p.failed||0],
      ['Skipped', p.skipped||0],
      ['Questions', (s.questions||[]).length],
      ['Cost (USD)', '$' + (c.usd||0).toFixed(4)],
      ['OCR pages', c.ocrPages||0],
    ].map(([label,num]) => \`<div class="card"><div class="num">\${num}</div><div class="label">\${label}</div>\${label==='Pages done' ? '<div class="bar-outer"><div class="bar-inner" style="width:'+(p.total?Math.round(100*p.done/p.total):0)+'%"></div></div>' : ''}</div>\`).join('');
    document.getElementById('pages').querySelector('tbody').innerHTML = (s.pages||[]).map(pg =>
      \`<tr><td>\${pg.index+1}</td><td>\${pg.filename||''}</td><td class="status-\${pg.status}">\${pg.status}</td><td>\${pg.pageType||''}</td><td>\${pg.modelPath||''}</td><td class="err">\${pg.error||''}</td></tr>\`
    ).join('');
    const qs = s.questions || [];
    document.getElementById('qcount').textContent = qs.length;
    document.getElementById('questions').querySelector('tbody').innerHTML = qs.slice(-60).reverse().map(q =>
      \`<tr><td><span class="badge">\${q.subject||'?'}</span></td><td>\${q.year||''}</td><td class="stem">\${(q.question||'').slice(0,220)}</td></tr>\`
    ).join('');
  } catch (e) {
    document.getElementById('status').textContent = 'poll error: ' + e.message;
  }
}
tick();
setInterval(tick, 2500);
</script>
</body></html>`);
});

export default router;
