// ============================================================
// authStore.js — Lưu trữ tài khoản / phiên / token reset / sổ cái ví xu
// Dùng JSON file trong data/ (cùng pattern readJson/writeJson của server.js).
// KHÔNG lưu plain-text password ở bất kỳ đâu.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.db');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.db');
const RESETS_FILE = path.join(DATA_DIR, 'resets.db');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.db');
const ADMIN_LOG_FILE = path.join(DATA_DIR, 'admin-log.db');
const CONFIG_FILE = path.join(DATA_DIR, 'config.db');
const HIDDEN_FILE = path.join(DATA_DIR, 'hidden-articles.db');
const REVIEW_FILE = path.join(DATA_DIR, 'review-queue.db');
const GAME_STATS_FILE = path.join(DATA_DIR, 'game-stats.db');

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
function readJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (v === null || v === undefined) ? fallback : v;
  } catch (e) { return fallback; }
}
function writeJson(file, obj) {
  ensureDir();
  // Ghi qua file tạm + rename để tránh file rỗng nếu process chết giữa chừng.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---------- Users ----------
function loadUsers() { return readJson(USERS_FILE, {}); }
function saveUsers(u) { writeJson(USERS_FILE, u); }
function findByEmail(users, email) {
  email = String(email || '').trim().toLowerCase();
  for (const id of Object.keys(users)) {
    if (users[id].email === email) return users[id];
  }
  return null;
}
function findByPhone(users, phone) {
  phone = normalizePhone(phone);
  if (!phone) return null;
  for (const id of Object.keys(users)) {
    if (users[id].phone === phone) return users[id];
  }
  return null;
}
function findById(users, id) { return users[id] || null; }
function characterNameTaken(users, name, exceptId) {
  for (const id of Object.keys(users)) {
    if (id === exceptId) continue;
    const c = users[id].character;
    if (c && c.name === name) return true;
  }
  return false;
}

// ---------- Sessions (key = sha256(token)) ----------
function loadSessions() { return readJson(SESSIONS_FILE, {}); }
function saveSessions(s) { writeJson(SESSIONS_FILE, s); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function sweepExpiredSessions() {
  const now = Date.now();
  const s = loadSessions();
  let changed = false;
  for (const k of Object.keys(s)) {
    if (!s[k].expires_at || s[k].expires_at <= now) { delete s[k]; changed = true; }
  }
  if (changed) saveSessions(s);
}

// ---------- Reset tokens (key = sha256(token)) ----------
function loadResets() { return readJson(RESETS_FILE, {}); }
function saveResets(r) { writeJson(RESETS_FILE, r); }

// ---------- Ledger: sổ cái ví xu (append-only) ----------
// Entry: { user_id, type: 'nap'|'tieu'|'tang', amount, balance_after, reason, at }
function loadLedger() { return readJson(LEDGER_FILE, []); }
function appendLedger(entry) {
  const l = loadLedger();
  if (!Array.isArray(l)) { writeJson(LEDGER_FILE, [entry]); return; }
  l.push(entry);
  // Giữ tối đa 50.000 dòng để file không phình vô hạn.
  const trimmed = l.length > 50000 ? l.slice(l.length - 50000) : l;
  writeJson(LEDGER_FILE, trimmed);
}
function ledgerForUser(userId, limit) {
  const l = loadLedger();
  if (!Array.isArray(l)) return [];
  return l.filter((e) => e && e.user_id === userId).slice(-(limit || 100)).reverse();
}

// Cộng/trừ xu cho user (amount âm = tiêu). Trả về balance mới hoặc null nếu lỗi.
function addBalance(userId, amount, type, reason) {
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount === 0) return null;
  if (['nap', 'tieu', 'tang'].indexOf(type) < 0) return null;
  const users = loadUsers();
  const u = users[userId];
  if (!u) return null;
  const after = (u.balance || 0) + amount;
  if (after < 0) return null; // không cho âm
  u.balance = after;
  saveUsers(users);
  appendLedger({
    user_id: userId, type: type, amount: amount, balance_after: after,
    reason: String(reason || '').slice(0, 200), at: Date.now(),
  });
  return after;
}

// ---------- Nhân vật ảo ----------
// Bảng mốc level theo công đức (đề xuất — xem báo cáo).
const MERIT_LEVELS = [
  { level: 1,  name: 'Phật tử mới',    min: 0 },
  { level: 2,  name: 'Thiện tín',      min: 100 },
  { level: 3,  name: 'Phật tử tinh tấn', min: 300 },
  { level: 4,  name: 'Cư sĩ',          min: 600 },
  { level: 5,  name: 'Cư sĩ tinh tấn', min: 1000 },
  { level: 6,  name: 'Hộ pháp',        min: 2000 },
  { level: 7,  name: 'Hộ pháp tinh tấn', min: 3500 },
  { level: 8,  name: 'Bồ tát đạo',     min: 5500 },
  { level: 9,  name: 'Thiện tri thức', min: 8000 },
  { level: 10, name: 'Bậc thầy',       min: 12000 },
];
function levelFromMerit(merit) {
  merit = Math.max(0, Math.floor(Number(merit) || 0));
  let cur = MERIT_LEVELS[0];
  for (const m of MERIT_LEVELS) { if (merit >= m.min) cur = m; }
  return { level: cur.level, level_name: cur.name, merit: merit };
}

// ---------- Ảnh đại diện mở khóa theo cấp ----------
// Mỗi cấp bậc mở khóa 1 ảnh (vị thần tiên / nhà sư Việt Nam) làm ảnh đại diện.
// Ảnh thật nằm ở /anh-mo-khoa/unlock-<n>.jpg trên web (tạo sau); đây chỉ là danh sách + đường dẫn.
const AVATAR_UNLOCKS = [
  { level: 1,  id: 'unlock-1',  name: 'Quan Âm Bồ Tát',   image: '/anh-mo-khoa/unlock-1.jpg' },
  { level: 2,  id: 'unlock-2',  name: 'Phật Di Lặc',      image: '/anh-mo-khoa/unlock-2.jpg' },
  { level: 3,  id: 'unlock-3',  name: 'Địa Tạng Bồ Tát',  image: '/anh-mo-khoa/unlock-3.jpg' },
  { level: 4,  id: 'unlock-4',  name: 'Thánh Gióng',      image: '/anh-mo-khoa/unlock-4.jpg' },
  { level: 5,  id: 'unlock-5',  name: 'Chử Đồng Tử',      image: '/anh-mo-khoa/unlock-5.jpg' },
  { level: 6,  id: 'unlock-6',  name: 'Liễu Hạnh',        image: '/anh-mo-khoa/unlock-6.jpg' },
  { level: 7,  id: 'unlock-7',  name: 'Trần Nhân Tông',   image: '/anh-mo-khoa/unlock-7.jpg' },
  { level: 8,  id: 'unlock-8',  name: 'Từ Đạo Hạnh',      image: '/anh-mo-khoa/unlock-8.jpg' },
  { level: 9,  id: 'unlock-9',  name: 'Không Lộ',         image: '/anh-mo-khoa/unlock-9.jpg' },
  { level: 10, id: 'unlock-10', name: 'Phật A Di Đà',     image: '/anh-mo-khoa/unlock-10.jpg' },
];
function avatarImageForId(avatarId) {
  const u = AVATAR_UNLOCKS.find((x) => x.id === avatarId);
  return u ? u.image : AVATAR_UNLOCKS[0].image; // mặc định ảnh cấp 1
}

// Tên nhân vật mặc định "Phật tử ####" — số ngẫu nhiên, không trùng.
function randomCharacterName(users) {
  for (let i = 0; i < 50; i++) {
    const n = 'Phật tử ' + (1000 + crypto.randomInt(9000));
    if (!characterNameTaken(users, n)) return n;
  }
  return 'Phật tử ' + Date.now().toString().slice(-4);
}

// Đồng bộ merit từ game (data/merit.db, key = tên nhân vật) vào character.merit.
// Không bao giờ giảm (dùng max) để đổi tên không mất công đức.
function syncMeritFromGame(user) {
  if (!user || !user.character) return user;
  const gameMerit = readJson(path.join(DATA_DIR, 'merit.db'), {});
  const gm = Math.floor(Number(gameMerit[user.character.name]) || 0);
  if (gm > (user.character.merit || 0)) {
    user.character.merit = gm;
    const lv = levelFromMerit(gm);
    user.character.level = lv.level;
    user.character.level_name = lv.level_name;
    user.character.updated_at = Date.now();
  }
  return user;
}

// ---------- Validate ----------
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}
// SĐT Việt Nam: 09/03/07/08/05 + 8 số; chấp nhận +84. Chuẩn hoá về 0xxxxxxxxx.
function normalizePhone(phone) {
  let p = String(phone || '').trim().replace(/[\s.\-()]/g, '');
  if (p.startsWith('+84')) p = '0' + p.slice(3);
  else if (p.startsWith('84') && p.length === 11) p = '0' + p.slice(2);
  if (!/^0(3|5|7|8|9)\d{8}$/.test(p)) return null;
  return p;
}
function newUserId() {
  return 'usr_' + crypto.randomBytes(8).toString('hex');
}

// ---------- Nhật ký thao tác admin (append-only, tối đa 2000 dòng) ----------
// Entry: { at, action, user_id, target, detail, before, after, reason }
function loadAdminLog() {
  const v = readJson(ADMIN_LOG_FILE, []);
  return Array.isArray(v) ? v : [];
}
function appendAdminLog(entry) {
  const l = loadAdminLog();
  l.push(Object.assign({ at: Date.now() }, entry || {}));
  const trimmed = l.length > 2000 ? l.slice(l.length - 2000) : l;
  writeJson(ADMIN_LOG_FILE, trimmed);
}
function adminLogForUser(userId, limit) {
  return loadAdminLog().filter((e) => e && e.user_id === userId).slice(-(limit || 50)).reverse();
}

// ---------- Lịch sử hoạt động tài khoản (append-only, tối đa 10.000 dòng) ----------
// Thọ giao 08/11/2026 — để mọi lỗi tài khoản đều truy vết được (đăng nhập sai,
// 401 khi dùng dịch vụ, khóa tạm...). Cùng mẫu sổ cái điểm (appendLedger).
// Entry: { user_id, ident, action, result: 'ok'|'fail', code, ip, ua, detail, at }
// - user_id: id tài khoản khi xác định được (null nếu chưa biết, vd đăng nhập
//   sai bằng email lạ). ident: email (lowercase) hoặc SĐT chuẩn hoá — để admin
//   tìm theo email/SĐT. KHÔNG ghi mật khẩu, token, session.
// - KHÔNG ghi /auth/me thành công (trang nào cũng gọi) — chỉ ghi /me khi có
//   cookie phiên gửi kèm nhưng không hợp lệ (xem doMe trong auth.js).
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.db');
const ACTIVITY_MAX = 10000;
function loadActivity() {
  const v = readJson(ACTIVITY_FILE, []);
  return Array.isArray(v) ? v : [];
}
function addActivity(entry) {
  const e = Object.assign({}, entry || {});
  e.user_id = e.user_id || null;
  e.ident = (e.ident != null && e.ident !== '') ? String(e.ident).slice(0, 120) : null;
  e.action = String(e.action || '').slice(0, 60);
  e.result = e.result === 'ok' ? 'ok' : 'fail';
  e.code = String(e.code || '').slice(0, 60);
  e.ip = String(e.ip || '').slice(0, 60);
  e.ua = String(e.ua || '').slice(0, 200);
  e.detail = String(e.detail || '').slice(0, 200);
  e.at = Number(e.at) || Date.now();
  const l = loadActivity();
  l.push(e);
  const trimmed = l.length > ACTIVITY_MAX ? l.slice(l.length - ACTIVITY_MAX) : l;
  writeJson(ACTIVITY_FILE, trimmed);
  return e;
}
function activityForUser(userId, limit) {
  return loadActivity().filter((e) => e && e.user_id === userId).slice(-(limit || 100)).reverse();
}
// Lịch sử mới nhất trước; filter: {user_id, ident, action, result, code, since}
function recentActivity(limit, filter) {
  const f = filter || {};
  let l = loadActivity();
  if (f.user_id) l = l.filter((e) => e && e.user_id === f.user_id);
  if (f.ident) l = l.filter((e) => e && e.ident === f.ident);
  if (f.action) l = l.filter((e) => e && e.action === f.action);
  if (f.result) l = l.filter((e) => e && e.result === f.result);
  if (f.code) l = l.filter((e) => e && e.code === f.code);
  if (f.since) l = l.filter((e) => e && (e.at || 0) >= f.since);
  return l.slice(-(limit || 100)).reverse();
}

// ---------- Cấu hình vận hành web (admin chỉnh qua trang quản trị) ----------
const DEFAULT_CONFIG = {
  game_enabled: true,
  review_mode: false,
  // TẠM KHOÁ THU ĐIỂM (Thọ lệnh 08/11/2026 ~11:33): false = dùng dịch vụ /
  // xem chuyên sâu miễn phí (không trừ điểm, không cần đăng nhập). Mở lại:
  // đặt true qua POST /admin/config — không cần deploy lại code.
  points_spending_enabled: false,
  max_players: 200,
  merit_points: {
    incense: 15, prostrate: 15, bell: 10, lantern: 10, wishcard: 10,
    chant: 5, beads: 2, mok: 2, drawFortune: 10, sit: 2, stand: 0,
  },
  announcement: { enabled: false, text: '' },
  popup: {
    doanhnhan: { title: '', text: '', ctaText: '', ctaHref: '' },
    mebe: { title: '', text: '', ctaText: '', ctaHref: '' },
    cauchuyen: { title: '', text: '', ctaText: '', ctaHref: '' },
  },
};
function loadConfig() {
  const raw = readJson(CONFIG_FILE, {});
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (raw && typeof raw === 'object') {
    if (typeof raw.game_enabled === 'boolean') cfg.game_enabled = raw.game_enabled;
    if (typeof raw.review_mode === 'boolean') cfg.review_mode = raw.review_mode;
    if (typeof raw.points_spending_enabled === 'boolean') cfg.points_spending_enabled = raw.points_spending_enabled;
    if (Number.isFinite(raw.max_players)) cfg.max_players = Math.max(10, Math.min(1000, Math.floor(raw.max_players)));
    if (raw.merit_points && typeof raw.merit_points === 'object') {
      for (const k of Object.keys(cfg.merit_points)) {
        if (Number.isFinite(raw.merit_points[k])) cfg.merit_points[k] = Math.max(0, Math.min(100, Math.floor(raw.merit_points[k])));
      }
    }
    if (raw.announcement && typeof raw.announcement === 'object') {
      if (typeof raw.announcement.enabled === 'boolean') cfg.announcement.enabled = raw.announcement.enabled;
      if (typeof raw.announcement.text === 'string') cfg.announcement.text = raw.announcement.text.slice(0, 300);
    }
    if (raw.popup && typeof raw.popup === 'object') {
      for (const page of ['doanhnhan', 'mebe', 'cauchuyen']) {
        const p = raw.popup[page];
        if (p && typeof p === 'object') {
          for (const f of ['title', 'text', 'ctaText', 'ctaHref']) {
            if (typeof p[f] === 'string') cfg.popup[page][f] = p[f].slice(0, 300);
          }
        }
      }
    }
  }
  return cfg;
}
function saveConfig(cfg) { writeJson(CONFIG_FILE, cfg); }

// ---------- Bài ẩn khỏi danh sách (mảng id) ----------
function loadHidden() {
  const v = readJson(HIDDEN_FILE, []);
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
function saveHidden(ids) { writeJson(HIDDEN_FILE, ids); }

// ---------- Hàng chờ duyệt bài (cron viết → admin duyệt mới đăng) ----------
function loadReview() {
  const v = readJson(REVIEW_FILE, { approved: [], rejected: [] });
  return {
    approved: Array.isArray(v.approved) ? v.approved : [],
    rejected: Array.isArray(v.rejected) ? v.rejected : [],
  };
}
function saveReview(r) { writeJson(REVIEW_FILE, r); }

// ---------- Thống kê game (tổng lượt vào, tổng phiên, tổng giây) ----------
function loadGameStats() {
  const v = readJson(GAME_STATS_FILE, {});
  return {
    total_joins: Math.max(0, Math.floor(Number(v.total_joins) || 0)),
    total_sessions: Math.max(0, Math.floor(Number(v.total_sessions) || 0)),
    total_seconds: Math.max(0, Math.floor(Number(v.total_seconds) || 0)),
  };
}
function saveGameStats(s) { writeJson(GAME_STATS_FILE, s); }

// Đổi tên nhân vật: dời điểm game (key = tên) từ tên cũ sang tên mới (lấy max).
function migrateGameMeritName(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  const gm = readJson(path.join(DATA_DIR, 'merit.db'), {});
  if (gm && typeof gm === 'object' && Number(gm[oldName])) {
    gm[newName] = Math.max(Number(gm[newName]) || 0, Number(gm[oldName]) || 0);
    delete gm[oldName];
    writeJson(path.join(DATA_DIR, 'merit.db'), gm);
  }
}

module.exports = {
  DATA_DIR,
  readJson, writeJson,
  loadUsers, saveUsers, findByEmail, findByPhone, findById,
  characterNameTaken, randomCharacterName,
  loadSessions, saveSessions, sha256hex, sweepExpiredSessions,
  loadResets, saveResets,
  loadLedger, appendLedger, ledgerForUser, addBalance,
  MERIT_LEVELS, levelFromMerit, syncMeritFromGame,
  AVATAR_UNLOCKS, avatarImageForId,
  validEmail, normalizePhone, newUserId,
  loadAdminLog, appendAdminLog, adminLogForUser,
  loadActivity, addActivity, activityForUser, recentActivity,
  DEFAULT_CONFIG, loadConfig, saveConfig,
  loadHidden, saveHidden,
  loadReview, saveReview,
  loadGameStats, saveGameStats,
  migrateGameMeritName,
};
