// ============================================================
// Chùa Online — Máy chủ game nhiều người chơi (multiplayer)
// + Webhook nghi thức cho livestream (TikFinity / Streamer.bot)
// + Bảng Vàng Công Đức (lưu vào data/merit.json)
//
// Chạy bằng Node.js + WebSocket (thư viện "ws"). Không cần DB.
//
// Cách chạy:
//   npm install
//   node server.js
//
// Biến môi trường:
//   PORT         cổng lắng nghe (mặc định 3000)
//   MAX_PLAYERS  số người tối đa trong một sân chùa (mặc định 200)
//   RITUAL_KEY   khóa bí mật cho webhook /ritual (không đặt = mở, nên đặt khi public)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '200', 10);
const RITUAL_KEY = process.env.RITUAL_KEY || '';
const HEARTBEAT_MS = 25000;
const TIMEOUT_MS = 60000;
const POS_BROADCAST_MS = 100;

// Điểm công đức cho từng hành động (theo ý tưởng tiktok-live-temple-rpc)
const MERIT_POINTS = {
  incense: 15, prostrate: 15, bell: 10, lantern: 10, wishcard: 10,
  chant: 5, beads: 2, mok: 2, drawFortune: 10, sit: 2, stand: 0,
};

// ---------- Bảng Vàng Công Đức (lưu file) ----------
const DATA_DIR = path.join(__dirname, 'data');
const MERIT_FILE = path.join(DATA_DIR, 'merit.json');
let merit = {};
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  merit = JSON.parse(fs.readFileSync(MERIT_FILE, 'utf8')) || {};
} catch (e) { merit = {}; }

let meritSaveTimer = null;
let meritDirty = false;
let lastBoardJson = '';

function boardTop(n) {
  return Object.entries(merit)
    .map(([name, points]) => ({ name, points }))
    .sort((a, b) => b.points - a.points)
    .slice(0, n || 10);
}
function scheduleMeritSave() {
  if (meritSaveTimer) return;
  meritSaveTimer = setTimeout(() => {
    meritSaveTimer = null;
    if (!meritDirty) return;
    meritDirty = false;
    try { fs.writeFileSync(MERIT_FILE, JSON.stringify(merit)); } catch (e) {}
  }, 5000);
}
function broadcastMerit() {
  const j = JSON.stringify(boardTop(10));
  if (j === lastBoardJson) return;
  lastBoardJson = j;
  broadcast({ t: 'merit', board: JSON.parse(j) });
}
function addMerit(name, pts) {
  if (!name || !pts) return;
  merit[name] = (merit[name] || 0) + pts;
  meritDirty = true;
  scheduleMeritSave();
  broadcastMerit();
}

// ---------- Quản lý người chơi ----------
const players = new Map(); // id -> { ws, name, x, y, z, ry, anim, lastSeen, hello, dirty }
let nextId = 1;

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).trim().slice(0, 20);
  s = s.replace(/[̀-ͯ\u007F]/g, '');
  return s;
}
function publicState(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, ry: p.ry, anim: p.anim };
}
function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    try { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data); } catch (e) {}
  }
}

// ---------- HTTP: webhook nghi thức + xem bảng vàng ----------
const server = http.createServer((req, res) => {
  // GET /merit — xem Bảng Vàng Công Đức (JSON)
  if (req.method === 'GET' && req.url === '/merit') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(boardTop(10)));
    return;
  }
  // POST /ritual — kích hoạt nghi thức từ bên ngoài
  // (TikFinity / Streamer.bot / curl). Body JSON:
  // { "k": "incense|bell|lantern|...", "user": "Tên", "wish": "lời khấn",
  //   "d": {...}, "key": "RITUAL_KEY nếu server có đặt" }
  if (req.method === 'POST' && req.url === '/ritual') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
      if (RITUAL_KEY && m.key !== RITUAL_KEY) { res.writeHead(403); res.end('forbidden'); return; }
      const k = String(m.k || '').slice(0, 24);
      if (!k) { res.writeHead(400); res.end('missing k'); return; }
      const user = sanitizeName(m.user) || 'Khán giả';
      const d = (m.d && typeof m.d === 'object') ? m.d : {};
      if (m.wish) d.wish = String(m.wish).slice(0, 200);
      d.user = user;
      broadcast({ t: 'act', id: 'streamer', k: k, d: d });
      addMerit(user, MERIT_POINTS[k] || 5);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Chua Online multiplayer server OK - ' + players.size + ' nguoi online');
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    try { ws.send(JSON.stringify({ t: 'full' })); } catch (e) {}
    ws.close();
    return;
  }
  const id = 'p' + (nextId++);
  const p = { id, ws, name: 'Phat tu ' + id, x: 0, y: 0, z: 8, ry: 0, anim: 'idle', lastSeen: Date.now(), hello: false, dirty: false };
  players.set(id, p);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    p.lastSeen = Date.now();

    if (m.t === 'hello') {
      const name = sanitizeName(m.name);
      if (name) p.name = name;
      p.hello = true;
      const others = [];
      for (const q of players.values()) { if (q.id !== id && q.hello) others.push(publicState(q)); }
      ws.send(JSON.stringify({ t: 'welcome', id: id, players: others, merit: boardTop(10) }));
      broadcast({ t: 'join', p: publicState(p) }, id);
    } else if (m.t === 'pos' && p.hello) {
      const nx = Number(m.x), ny = Number(m.y), nz = Number(m.z), nr = Number(m.ry);
      if (Number.isFinite(nx)) p.x = Math.max(-500, Math.min(500, nx));
      if (Number.isFinite(ny)) p.y = Math.max(-100, Math.min(100, ny));
      if (Number.isFinite(nz)) p.z = Math.max(-500, Math.min(500, nz));
      if (Number.isFinite(nr)) p.ry = nr;
      if (typeof m.a === 'string') p.anim = m.a.slice(0, 16);
      p.dirty = true;
    } else if (m.t === 'act' && p.hello) {
      const k = String(m.k || '').slice(0, 24);
      if (!k) return;
      const d = (m.d && typeof m.d === 'object') ? m.d : {};
      d.user = p.name;
      broadcast({ t: 'act', id: id, k: k, d: d }, id);
      addMerit(p.name, MERIT_POINTS[k] || 0);
    } else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
  });

  ws.on('close', () => { clearInterval(hb); players.delete(id); broadcast({ t: 'leave', id: id }); });
  ws.on('error', () => {});

  const hb = setInterval(() => {
    if (Date.now() - p.lastSeen > TIMEOUT_MS) { try { ws.terminate(); } catch (e) {} }
    else { try { ws.ping(); } catch (e) {} }
  }, HEARTBEAT_MS);
});

setInterval(() => {
  const list = [];
  for (const p of players.values()) { if (p.hello && p.dirty) { list.push(publicState(p)); p.dirty = false; } }
  if (list.length) broadcast({ t: 'poss', list: list });
}, POS_BROADCAST_MS);

server.listen(PORT, () => {
  console.log('Chua Online server dang chay o cong ' + PORT + ' (toi da ' + MAX_PLAYERS + ' nguoi)');
});
