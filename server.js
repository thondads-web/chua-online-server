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

// ---------- Lọc từ ngữ không phù hợp môi trường Phật pháp ----------
// Chặn: nói bậy/thô tục, chửi bới/nhục mạ, đòi nợ — thay bằng ***
const BANNED_SRC = [
  // Nói bậy / thô tục
  'địt', 'đ!t', 'lồn', 'cặc', 'đéo', 'cứt', 'đĩ',
  'dm', 'đm', 'dmm', 'đmm', 'dcm', 'đcm', 'đcmn', 'vcl',
  // Chửi bới / nhục mạ
  'đồ chó', 'súc vật', 'óc chó', 'não chó', 'câm mồm',
  'chết mẹ', 'chết cha', 'chết tiệt',
  'đồ ngu', 'thằng ngu', 'con ngu',
  // Đòi nợ / quấy rối nợ nần
  'đòi nợ', 'siết nợ', 'xiết nợ', 'giang hồ',
];
function cleanText(s) {
  let out = String(s || '');
  for (const w of BANNED_SRC) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // cho phép viết tắt lách bằng dấu chấm/khoảng trắng (vd: d.m, d m)
    const flex = esc.split('').join('[.\\s]*');
    const re = new RegExp('(^|[^\\p{L}\\p{N}])' + flex + '([^\\p{L}\\p{N}]|$)', 'giu');
    out = out.replace(re, (m, p1, p2) => p1 + '***' + p2);
  }
  return out;
}
function hasRealContent(s) {
  return String(s || '').replace(/[\s*]/g, '').length > 0;
}
// ---------- Sổ cúng dường + Góp ý (dữ liệu thuộc về web mình) ----------
const DONORS_FILE = path.join(DATA_DIR, 'donors.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); } catch (e) {}
}
// Chống spam theo IP
const ipHits = new Map(); // ip -> {donate: ts, feedback: ts}
function ipLimited(ip, kind, ms) {
  const now = Date.now();
  let rec = ipHits.get(ip);
  if (!rec) { rec = {}; ipHits.set(ip, rec); }
  if (now - (rec[kind] || 0) < ms) return true;
  rec[kind] = now;
  return false;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0] : '').trim() || req.socket.remoteAddress || 'unknown';
}
function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => cb(body));
}

// ---------- Quản lý người chơi ----------
const players = new Map(); // id -> { ws, name, x, y, z, ry, anim, lastSeen, hello, dirty, lastChat }
let nextId = 1;

// ---------- Chat chung (quán trà đá / sân chùa) ----------
const chatHistory = []; // {id, name, text, ts} — giữ 30 tin gần nhất
const CHAT_MIN_MS = 1500; // chống spam: mỗi người cách nhau ít nhất 1.5 giây

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
  // GET /donors — danh sách thí chủ cúng dường (mới nhất trước) + tổng tiền
  if (req.method === 'GET' && req.url === '/donors') {
    const donors = readJson(DONORS_FILE, []);
    const total = donors.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ donors: donors.slice(-20).reverse(), total: total, count: donors.length }));
    return;
  }
  // POST /donate — ghi nhận cúng dường {name, amount, wish}
  if (req.method === 'POST' && req.url === '/donate') {
    if (ipLimited(clientIp(req), 'donate', 30000)) { res.writeHead(429); res.end('slow down'); return; }
    readBody(req, (body) => {
      let m; try { m = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
      const name = sanitizeName(m.name);
      const amount = Math.floor(Number(m.amount) || 0);
      const wish = cleanText(String(m.wish || '').trim().slice(0, 200));
      if (!name || !(amount > 0) || amount > 1000000000) { res.writeHead(400); res.end('bad data'); return; }
      const donors = readJson(DONORS_FILE, []);
      donors.push({ name: name, amount: amount, wish: wish, ts: Date.now() });
      while (donors.length > 200) donors.shift();
      writeJson(DONORS_FILE, donors);
      addMerit(name, Math.min(500, Math.floor(amount / 1000))); // 1.000đ = 1 điểm, tối đa 500
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  // GET /feedback — đọc góp ý (mới nhất trước)
  if (req.method === 'GET' && req.url === '/feedback') {
    const fb = readJson(FEEDBACK_FILE, []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(fb.slice(-20).reverse()));
    return;
  }
  // POST /feedback — gửi góp ý {name, text}
  if (req.method === 'POST' && req.url === '/feedback') {
    if (ipLimited(clientIp(req), 'feedback', 60000)) { res.writeHead(429); res.end('slow down'); return; }
    readBody(req, (body) => {
      let m; try { m = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
      const name = sanitizeName(m.name) || 'Thí chủ ẩn danh';
      const text = cleanText(String(m.text || '').trim().slice(0, 500));
      if (!hasRealContent(text)) { res.writeHead(400); res.end('bad data'); return; }
      const fb = readJson(FEEDBACK_FILE, []);
      fb.push({ name: name, text: text, ts: Date.now() });
      while (fb.length > 200) fb.shift();
      writeJson(FEEDBACK_FILE, fb);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  // ---------- Thống kê truy cập (báo cáo mỗi sáng) ----------
  const STATS_FILE = path.join(DATA_DIR, 'stats.json');
  const STATS_TYPES = ['pv', 'dwell', 'feat'];
  function statsDayKey(ts) {
    const d = new Date(Number(ts) || Date.now());
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + dd;
  }
  function validStatsStr(s) { return typeof s === 'string' && s.length > 0 && s.length <= 64; }
  function pruneStats(stats) {
    const keys = Object.keys(stats).sort(); // YYYY-MM-DD xếp theo thời gian
    while (keys.length > 30) { delete stats[keys.shift()]; }
  }
  // POST /stats — nhận batch sự kiện analytics từ web (tối đa 100 events/request)
  // Body: {events:[{t:"pv"|"dwell"|"feat", p:"home"|"boitoan", s:"ten-section",
  //                 f:"ten-tinh-nang", d:so-giay, ts:epoch_ms}, ...]}
  if (req.method === 'POST' && req.url === '/stats') {
    if (ipLimited(clientIp(req), 'stats', 10000)) { res.writeHead(429); res.end('slow down'); return; }
    readBody(req, (body) => {
      let m; try { m = JSON.parse(body); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
      const events = m.events;
      if (!Array.isArray(events) || events.length === 0 || events.length > 100) { res.writeHead(400); res.end('bad data'); return; }
      const stats = readJson(STATS_FILE, {});
      let accepted = 0;
      for (const e of events) {
        if (!e || typeof e !== 'object') continue;
        if (!STATS_TYPES.includes(e.t)) continue;
        if (!validStatsStr(e.p)) continue;
        let dur = 0;
        if (e.t === 'dwell') {
          if (!validStatsStr(e.s)) continue;
          dur = Number(e.d);
          if (!Number.isFinite(dur) || dur < 0 || dur > 3600) continue;
        }
        if (e.t === 'feat') { if (!validStatsStr(e.f)) continue; }
        const day = statsDayKey(e.ts);
        if (!stats[day]) stats[day] = { pageviews: {}, dwell: {}, features: {} };
        const rec = stats[day];
        if (e.t === 'pv') rec.pageviews[e.p] = (rec.pageviews[e.p] || 0) + 1;
        else if (e.t === 'dwell') { const k = e.p + ':' + e.s; rec.dwell[k] = (rec.dwell[k] || 0) + dur; }
        else if (e.t === 'feat') rec.features[e.f] = (rec.features[e.f] || 0) + 1;
        accepted++;
      }
      pruneStats(stats);
      writeJson(STATS_FILE, stats);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, accepted: accepted }));
    });
    return;
  }
  // GET /stats/summary?days=7 — tổng hợp N ngày gần nhất
  if (req.method === 'GET' && req.url.startsWith('/stats/summary')) {
    let days = 7;
    try {
      const u = new URL(req.url, 'http://localhost');
      const q = parseInt(u.searchParams.get('days'), 10);
      if (Number.isFinite(q)) days = Math.max(1, Math.min(30, q));
    } catch (e) {}
    const stats = readJson(STATS_FILE, {});
    const keys = Object.keys(stats).sort().slice(-days);
    const pageviews = { home: 0, boitoan: 0 };
    const dwellAgg = {}, featAgg = {};
    let totalEvents = 0;
    for (const k of keys) {
      const rec = stats[k] || {};
      for (const [p, n] of Object.entries(rec.pageviews || {})) {
        if (p === 'home') pageviews.home += n;
        else if (p === 'boitoan') pageviews.boitoan += n;
        totalEvents += n;
      }
      for (const [s, sec] of Object.entries(rec.dwell || {})) dwellAgg[s] = (dwellAgg[s] || 0) + sec;
      for (const [f, n] of Object.entries(rec.features || {})) { featAgg[f] = (featAgg[f] || 0) + n; totalEvents += n; }
    }
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      days: keys, pageviews: pageviews,
      topDwell: top(dwellAgg, 10), topFeatures: top(featAgg, 10),
      totalEvents: totalEvents,
    }));
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
      ws.send(JSON.stringify({ t: 'welcome', id: id, players: others, merit: boardTop(10), chat: chatHistory.slice(-20) }));
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
    } else if (m.t === 'chat' && p.hello) {
      // Chat chung: mọi người nói chuyện tự nhiên (quán trà đá).
      // Chống spam: tối thiểu 1.5s/tin, tối đa 200 ký tự, lọc ký tự HTML.
      const now = Date.now();
      if (now - (p.lastChat || 0) < CHAT_MIN_MS) return;
      let text = String(m.text || '').trim().slice(0, 200).replace(/[<>&]/g, '');
      text = cleanText(text); // lọc từ ngữ không phù hợp môi trường Phật pháp
      if (!hasRealContent(text)) return; // toàn từ cấm → bỏ tin
      p.lastChat = now;
      const msg = { t: 'chat', id: p.id, name: p.name, text: text, ts: now };
      chatHistory.push(msg);
      if (chatHistory.length > 30) chatHistory.shift();
      broadcast(msg);
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

// ---------- TikTok LIVE: quà tặng / like / follow → nghi thức tự động ----------
// Nghe livestream TikTok của chủ chùa (không cần đăng nhập, chỉ cần username).
// Khi khán giả tặng quà → tự rung chuông + cộng công đức + hiện tên lên Bảng Vàng.
// Like → gõ mõ. Follow → thắp hương chào mừng. Share → cộng công đức.
// CHỈ hoạt động khi chủ chùa đang LIVE.
// Lưu ý trung thực: tiktok-live-connector là reverse-engineering, TikTok đổi API
// có thể làm nó ngừng chạy — webhook POST /ritual ở trên luôn là đường dự phòng.
// Biến môi trường: TIKTOK_USERNAME (mặc định megan.3t), TIKTOK_ENABLED=0 để tắt.
const TIKTOK_USERNAME = String(process.env.TIKTOK_USERNAME || 'megan.3t').replace(/^@/, '').trim() || 'megan.3t';
const TIKTOK_ENABLED = process.env.TIKTOK_ENABLED !== '0';
// tiktok-live-connector v2 là ESM-only ("type": "module") nên require() trong
// CommonJS sẽ lỗi ERR_REQUIRE_ESM — phải dùng import() động (Node 18+ hỗ trợ).
let TikTokLiveConnection = null;

function ttUser(data) {
  const u = (data && data.user) || {};
  return sanitizeName(u.nickname || u.uniqueId || data.nickname || data.uniqueId) || 'Khan gia TikTok';
}
function ttGift(data) {
  const ext = data.extendedGiftInfo || {};
  const giftName = data.giftName || ext.name || ('qua #' + (data.giftId || '?'));
  const diamonds = Number(data.diamondCount || ext.diamondCost || 0) || 0;
  return { giftName: String(giftName).slice(0, 40), diamonds: diamonds };
}
function ttRitual(user, k, extra) {
  const d = Object.assign({}, extra, { user: user, from: 'tiktok' });
  broadcast({ t: 'act', id: 'streamer', k: k, d: d });
}

function startTikTokListener() {
if (TIKTOK_ENABLED && TikTokLiveConnection) {
  const tt = new TikTokLiveConnection(TIKTOK_USERNAME, { enableExtendedGiftInfo: true });
  let ttRetry = null;
  let likeAcc = 0;

  // Quà tặng → rung chuông + công đức theo giá trị quà
  tt.on('gift', (data) => {
    try {
      if (!data.repeatEnd) return; // chỉ tính khi gửi xong chuỗi quà
      const user = ttUser(data);
      const g = ttGift(data);
      const pts = Math.max(10, Math.min(200, g.diamonds || 10));
      ttRitual(user, 'bell', { gift: g.giftName, diamonds: g.diamonds });
      addMerit(user, pts);
      console.log('[TikTok] ' + user + ' tang "' + g.giftName + '" (' + g.diamonds + ' kc) +' + pts + ' cong duc');
    } catch (e) {}
  });

  // Like → cứ 200 like gõ mõ một tiếng
  tt.on('like', (data) => {
    try {
      likeAcc += Number(data.count || 1) || 1;
      if (likeAcc >= 200) {
        likeAcc = 0;
        const user = ttUser(data);
        ttRitual(user, 'mok', { likes: 200 });
        addMerit(user, 2);
      }
    } catch (e) {}
  });

  // Follow → thắp hương chào mừng + lên Bảng Vàng
  tt.on('follow', (data) => {
    try {
      const user = ttUser(data);
      ttRitual(user, 'incense', { note: 'chao mung' });
      addMerit(user, 5);
      console.log('[TikTok] ' + user + ' vua follow');
    } catch (e) {}
  });

  // Share live → cộng công đức
  tt.on('share', (data) => {
    try { addMerit(ttUser(data), 10); } catch (e) {}
  });

  function ttConnect() {
    tt.connect().then((state) => {
      console.log('[TikTok] Da noi LIVE @' + TIKTOK_USERNAME + ' (room ' + state.roomId + ')');
    }).catch((err) => {
      const msg = err && err.message ? err.message : String(err);
      console.log('[TikTok] Chua live hoac loi (' + msg.slice(0, 80) + ') — thu lai sau 5 phut.');
      clearTimeout(ttRetry);
      ttRetry = setTimeout(ttConnect, 5 * 60 * 1000);
    });
  }
  tt.on('disconnected', () => {
    console.log('[TikTok] Mat ket noi live — thu lai sau 1 phut.');
    clearTimeout(ttRetry);
    ttRetry = setTimeout(ttConnect, 60 * 1000);
  });
  tt.on('streamEnd', () => {
    console.log('[TikTok] Live ket thuc — doi live moi (5 phut).');
    clearTimeout(ttRetry);
    ttRetry = setTimeout(ttConnect, 5 * 60 * 1000);
  });
  ttConnect();
} else {
  console.log('[TikTok] Tat listener (TIKTOK_ENABLED=0 hoac thieu thu vien).');
  return;
}
}

// Tải động thư viện ESM rồi mới khởi động listener
import('tiktok-live-connector').then((mod) => {
  TikTokLiveConnection = mod.TikTokLiveConnection;
  startTikTokListener();
}).catch((e) => {
  console.log('[TikTok] Khong tai duoc thu vien tiktok-live-connector:', (e && e.message) || e);
  startTikTokListener();
});

server.listen(PORT, () => {
  console.log('Chua Online server dang chay o cong ' + PORT + ' (toi da ' + MAX_PLAYERS + ' nguoi)');
});
