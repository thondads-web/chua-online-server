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
};
