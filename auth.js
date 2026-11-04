// ============================================================
// auth.js — Router /auth/* : đăng ký / đăng nhập / quên mật khẩu
// + ví xu + nhân vật ảo. Mount vào server.js bằng 1 dòng.
// Không JWT — dùng opaque session token trong HttpOnly cookie.
// ============================================================
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./authStore');
const mailer = require('./mailer');

const WEB_ORIGIN = 'https://phatphaponline.pages.dev';
const WEB_BASE = 'https://phatphaponline.pages.dev';
const SESSION_DAYS = 30;
const BCRYPT_COST = 12;
const RESET_TTL_MS = 60 * 60 * 1000; // 60 phút
const LOCK_AFTER_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 phút
const RENAME_COST_XU = 100; // stub: đổi tên lần 2+ tốn xu (chưa trừ thật)

// ---------- CORS ----------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(res, status, obj, extraHeaders) {
  const h = Object.assign(
    { 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(), extraHeaders || {}
  );
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}
function err(res, status, code, message, extra) {
  json(res, status, Object.assign({ error: code, message: message }, extra || {}));
}

// ---------- Helpers ----------
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0] : '').trim() || req.socket.remoteAddress || 'unknown';
}
function getSessionToken(req) {
  const h = req.headers.cookie || '';
  const m = h.match(/(?:^|;\s*)session=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
}
function sanitizeCharName(raw) {
  let s = String(raw == null ? '' : raw).trim().slice(0, 20);
  s = s.replace(/[̀-ͯ\u007F]/g, '');
  return s;
}
function setSessionCookie(res, token) {
  // SameSite=None để fetch cross-site (pages.dev → bonto.run) kèm cookie được.
  // (Design ghi Lax — Lax chặn cookie trên fetch cross-site nên phải dùng None.)
  res.setHeader('Set-Cookie',
    'session=' + encodeURIComponent(token) +
    '; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=' + (SESSION_DAYS * 24 * 3600));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0');
}
function publicUser(u) {
  return {
    id: u.id,
    email: u.email || null,
    phone: u.phone || null,
    character: {
      name: u.character.name,
      merit: u.character.merit || 0,
      level: u.character.level || 1,
      level_name: u.character.level_name || 'Phật tử mới',
      updated_at: u.character.updated_at || 0,
    },
    balance: u.balance || 0,
    created_at: u.created_at,
  };
}

// ---------- Rate limit (in-memory) ----------
const rl = new Map(); // key -> { count, resetAt }
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let r = rl.get(key);
  if (!r || now >= r.resetAt) { r = { count: 0, resetAt: now + windowMs }; rl.set(key, r); }
  r.count += 1;
  if (r.count > limit) return Math.ceil((r.resetAt - now) / 1000);
  return 0;
}
const _rlSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, r] of rl) { if (now >= r.resetAt) rl.delete(k); }
}, 10 * 60 * 1000);
if (_rlSweep.unref) _rlSweep.unref();
const _sessSweep = setInterval(() => { try { store.sweepExpiredSessions(); } catch (e) {} }, 60 * 60 * 1000);
if (_sessSweep.unref) _sessSweep.unref();

// ---------- Session ----------
function createSession(users, userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = store.loadSessions();
  const now = Date.now();
  sessions[store.sha256hex(token)] = {
    user_id: userId, created_at: now,
    expires_at: now + SESSION_DAYS * 24 * 3600 * 1000,
    ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  store.saveSessions(sessions);
  return token;
}
function getAuthUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const key = store.sha256hex(token);
  const sessions = store.loadSessions();
  const s = sessions[key];
  if (!s) return null;
  if (!s.expires_at || s.expires_at <= Date.now()) {
    delete sessions[key]; store.saveSessions(sessions); return null;
  }
  const users = store.loadUsers();
  const u = store.findById(users, s.user_id);
  if (!u) { delete sessions[key]; store.saveSessions(sessions); return null; }
  // Đồng bộ merit từ game (không bao giờ giảm).
  store.syncMeritFromGame(u);
  return { user: u, users: users, sessionKey: key };
}
function destroyUserSessions(userId, exceptKey) {
  const sessions = store.loadSessions();
  let changed = false;
  for (const k of Object.keys(sessions)) {
    if (sessions[k].user_id === userId && k !== exceptKey) { delete sessions[k]; changed = true; }
  }
  if (changed) store.saveSessions(sessions);
}

// ---------- Router ----------
async function handleAuth(req, res) {
  let pathname = '/auth';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) {}
  if (!pathname.startsWith('/auth')) return false;

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }

  const route = pathname.slice('/auth'.length) || '/';

  // Chuẩn bị body cho các method có body
  let body = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    const raw = await readBody(req);
    if (raw) {
      try { body = JSON.parse(raw); } catch (e) {
        return err(res, 400, 'du_lieu_khong_hop_le', 'Dữ liệu gửi lên không đúng định dạng.');
      }
    }
  }
  if (!body || typeof body !== 'object') body = {};

  try {
    if (route === '/register' && req.method === 'POST') return await doRegister(req, res, body);
    if (route === '/login' && req.method === 'POST') return await doLogin(req, res, body);
    if (route === '/logout' && req.method === 'POST') return doLogout(req, res);
    if (route === '/me' && req.method === 'GET') return doMe(req, res);
    if (route === '/forgot-password' && req.method === 'POST') return await doForgot(req, res, body);
    if (route === '/reset-password' && req.method === 'POST') return await doReset(req, res, body);
    if (route === '/wallet' && req.method === 'GET') return doWallet(req, res);
    if (route === '/character' && req.method === 'GET') return doCharacterGet(req, res);
    if (route === '/character' && req.method === 'PATCH') return doCharacterPatch(req, res, body);
    if (route === '/admin/stats' && req.method === 'GET') return doAdminStats(req, res);
  } catch (e) {
    console.log('[auth] lỗi: ' + (e && e.message));
    return err(res, 500, 'loi_he_thong', 'Hệ thống bận, thí chủ thử lại sau.');
  }
  return err(res, 404, 'khong_tim_thay', 'Không tìm thấy.');
}

// ---------- POST /auth/register ----------
async function doRegister(req, res, body) {
  const ip = clientIp(req);
  const rlS = rateLimited('reg:ip:' + ip, 3, 3600 * 1000);
  if (rlS) { res.setHeader('Retry-After', rlS); return err(res, 429, 'qua_nhieu_yeu_cau', 'Thí chủ thao tác quá nhanh, thử lại sau ' + rlS + ' giây.'); }

  let email = String(body.email || '').trim().toLowerCase() || null;
  let phone = body.phone != null ? store.normalizePhone(body.phone) : null;
  const password = String(body.password || '');

  if (body.phone != null && !phone) {
    return err(res, 400, 'so_dien_thoai_khong_hop_le', 'Số điện thoại chưa đúng (đầu 09/03/07/08/05, 10 số).');
  }
  if (!email && !phone) {
    return err(res, 400, 'thieu_thong_tin', 'Cần email hoặc số điện thoại để đăng ký.');
  }
  if (email && !store.validEmail(email)) {
    return err(res, 400, 'email_khong_hop_le', 'Email chưa đúng định dạng.');
  }
  if (password.length < 8 || password.length > 72) {
    return err(res, 400, 'mat_khau_yeu', 'Mật khẩu tối thiểu 8 ký tự.');
  }

  const users = store.loadUsers();
  if (email && store.findByEmail(users, email)) {
    return err(res, 409, 'email_ton_tai', 'Email này đã có tài khoản.');
  }
  if (phone && store.findByPhone(users, phone)) {
    return err(res, 409, 'so_dien_thoai_ton_tai', 'Số điện thoại này đã có tài khoản.');
  }

  // Tên nhân vật: người dùng đặt hoặc mặc định "Phật tử ####" (không trùng).
  let charName = sanitizeCharName(body.name);
  if (!charName) charName = store.randomCharacterName(users);
  else if (store.characterNameTaken(users, charName)) {
    return err(res, 409, 'ten_nhan_vat_ton_tai', 'Tên nhân vật này đã có người dùng.');
  }

  const password_hash = bcrypt.hashSync(password, BCRYPT_COST);
  const id = store.newUserId();
  const now = Date.now();
  users[id] = {
    id: id,
    email: email,
    phone: phone,
    password_hash: password_hash,
    character: {
      name: charName, merit: 0, level: 1, level_name: 'Phật tử mới',
      updated_at: now, renamed_count: 0,
    },
    balance: 0,
    created_at: now,
    last_login_at: now,
    failed_attempts: 0,
    locked_until: 0,
  };
  store.saveUsers(users);

  const token = createSession(users, id, req);
  setSessionCookie(res, token);
  return json(res, 201, { ok: true, user: publicUser(users[id]) });
}

// ---------- POST /auth/login ----------
async function doLogin(req, res, body) {
  const ip = clientIp(req);
  let rlS = rateLimited('login:ip:' + ip, 5, 15 * 60 * 1000);
  if (rlS) { res.setHeader('Retry-After', rlS); return err(res, 429, 'qua_nhieu_yeu_cau', 'Thí chủ thử quá nhiều lần, nghỉ ' + rlS + ' giây rồi thử lại.'); }

  let email = String(body.email || '').trim().toLowerCase() || null;
  let phone = body.phone != null ? store.normalizePhone(body.phone) : null;
  const password = String(body.password || '');
  if (!email && !phone) {
    return err(res, 400, 'thieu_thong_tin', 'Cần email hoặc số điện thoại để đăng nhập.');
  }
  if (!password) {
    return err(res, 400, 'thieu_thong_tin', 'Thiếu mật khẩu.');
  }
  const identKey = 'login:id:' + (email || phone);
  rlS = rateLimited(identKey, 10, 3600 * 1000);
  if (rlS) { res.setHeader('Retry-After', rlS); return err(res, 429, 'qua_nhieu_yeu_cau', 'Thử lại sau ' + rlS + ' giây.'); }

  const users = store.loadUsers();
  const user = email ? store.findByEmail(users, email) : store.findByPhone(users, phone);
  const now = Date.now();
  // Dùng 1 mã lỗi chung cho "không tồn tại" và "sai mật khẩu" — chống dò tài khoản.
  if (user && user.locked_until && user.locked_until > now) {
    const retry = Math.ceil((user.locked_until - now) / 1000);
    res.setHeader('Retry-After', retry);
    return err(res, 423, 'tai_khoan_tam_khoa',
      'Tài khoản tạm khóa vì nhập sai nhiều lần. Thử lại sau ' + Math.ceil(retry / 60) + ' phút.',
      { retry_after_giay: retry });
  }
  let ok = false;
  if (user) {
    try { ok = bcrypt.compareSync(password, user.password_hash); } catch (e) { ok = false; }
  }
  if (!user || !ok) {
    if (user) {
      user.failed_attempts = (user.failed_attempts || 0) + 1;
      if (user.failed_attempts >= LOCK_AFTER_FAILS) {
        user.locked_until = now + LOCK_MS;
        user.failed_attempts = 0;
      }
      store.saveUsers(users);
    }
    return err(res, 401, 'sai_thong_tin', 'Email/số điện thoại hoặc mật khẩu chưa đúng.');
  }
  user.failed_attempts = 0;
  user.locked_until = 0;
  user.last_login_at = now;
  store.saveUsers(users);

  const token = createSession(users, user.id, req);
  setSessionCookie(res, token);
  store.syncMeritFromGame(user);
  return json(res, 200, { ok: true, user: publicUser(user) });
}

// ---------- POST /auth/logout ----------
function doLogout(req, res) {
  const token = getSessionToken(req);
  if (token) {
    const sessions = store.loadSessions();
    const key = store.sha256hex(token);
    if (sessions[key]) { delete sessions[key]; store.saveSessions(sessions); }
  }
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

// ---------- GET /auth/me ----------
function doMe(req, res) {
  const a = getAuthUser(req);
  if (!a) return json(res, 200, { logged_in: false });
  const users = a.users;
  store.saveUsers(users); // lưu merit đã đồng bộ (nếu có)
  return json(res, 200, { logged_in: true, user: publicUser(a.user) });
}

// ---------- POST /auth/forgot-password ----------
async function doForgot(req, res, body) {
  let email = String(body.email || '').trim().toLowerCase() || null;
  let phone = body.phone != null ? store.normalizePhone(body.phone) : null;
  if (body.phone != null && !phone) {
    return err(res, 400, 'so_dien_thoai_khong_hop_le', 'Số điện thoại chưa đúng định dạng.');
  }
  if (email && !store.validEmail(email)) {
    return err(res, 400, 'email_khong_hop_le', 'Email chưa đúng định dạng.');
  }
  if (!email && !phone) {
    return err(res, 400, 'thieu_thong_tin', 'Cần email hoặc số điện thoại.');
  }
  const ident = email || phone;
  const rlS = rateLimited('forgot:' + ident, 3, 3600 * 1000);
  if (rlS) { res.setHeader('Retry-After', rlS); return err(res, 429, 'qua_nhieu_yeu_cau', 'Thử lại sau ' + rlS + ' giây.'); }

  const generic = { ok: true, message: 'Nếu thông tin tồn tại, hướng dẫn đặt lại đã được gửi.' };
  const users = store.loadUsers();
  const user = email ? store.findByEmail(users, email) : store.findByPhone(users, phone);
  if (!user) return json(res, 200, generic); // luôn 200 — chống dò tài khoản

  // Tài khoản SĐT: chưa có SMS gateway → hướng dẫn liên hệ hỗ trợ.
  if (!user.email) {
    return json(res, 200, {
      ok: true,
      message: 'Tài khoản đăng ký bằng số điện thoại — vui lòng liên hệ hỗ trợ để lấy lại mật khẩu.',
    });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const resets = store.loadResets();
  resets[store.sha256hex(token)] = {
    user_id: user.id, expires_at: Date.now() + RESET_TTL_MS, used: false,
  };
  store.saveResets(resets);

  const link = WEB_BASE + '/?reset=' + token;
  const sent = await mailer.sendResetEmail(user.email, link);
  const out = Object.assign({}, generic);
  if (!sent.sent && sent.dev) {
    // Chế độ dev (chưa cấu hình email): báo rõ, token CHỈ nằm trong server log.
    out.dev_note = 'Email chưa cấu hình (thiếu RESEND_API_KEY) — link đặt lại đã ghi vào server log, chưa gửi email thật.';
  }
  return json(res, 200, out);
}

// ---------- POST /auth/reset-password ----------
async function doReset(req, res, body) {
  const token = String(body.token || '');
  const newPw = String(body.new_password || '');
  if (!token || newPw.length < 8 || newPw.length > 72) {
    if (newPw && (newPw.length < 8 || newPw.length > 72)) {
      return err(res, 400, 'mat_khau_yeu', 'Mật khẩu tối thiểu 8 ký tự.');
    }
    return err(res, 400, 'token_khong_hop_le', 'Link đặt lại không hợp lệ hoặc đã hết hạn.');
  }
  const key = store.sha256hex(token);
  const rlS = rateLimited('reset:' + key, 10, 3600 * 1000);
  if (rlS) { res.setHeader('Retry-After', rlS); return err(res, 429, 'qua_nhieu_yeu_cau', 'Thử lại sau ' + rlS + ' giây.'); }

  const resets = store.loadResets();
  const r = resets[key];
  // 1 mã lỗi chung cho mọi trường hợp token sai/hết hạn/đã dùng.
  if (!r || r.used || !r.expires_at || r.expires_at <= Date.now()) {
    return err(res, 400, 'token_khong_hop_le', 'Link đặt lại không hợp lệ hoặc đã hết hạn.');
  }
  const users = store.loadUsers();
  const user = store.findById(users, r.user_id);
  if (!user) return err(res, 400, 'token_khong_hop_le', 'Link đặt lại không hợp lệ hoặc đã hết hạn.');

  user.password_hash = bcrypt.hashSync(newPw, BCRYPT_COST);
  user.failed_attempts = 0;
  user.locked_until = 0;
  store.saveUsers(users);
  r.used = true;
  store.saveResets(resets);
  // Xóa toàn bộ session cũ — mọi thiết bị phải đăng nhập lại.
  destroyUserSessions(user.id, null);

  return json(res, 200, { ok: true, message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' });
}

// ---------- GET /auth/wallet ----------
function doWallet(req, res) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  return json(res, 200, {
    ok: true,
    balance: a.user.balance || 0,
    history: store.ledgerForUser(a.user.id, 100),
  });
}

// ---------- GET /auth/character ----------
function doCharacterGet(req, res) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const users = a.users;
  store.saveUsers(users); // lưu merit đã đồng bộ (nếu có)
  const c = a.user.character;
  return json(res, 200, {
    ok: true,
    character: {
      name: c.name, merit: c.merit || 0, level: c.level || 1,
      level_name: c.level_name || 'Phật tử mới', updated_at: c.updated_at || 0,
    },
  });
}

// ---------- PATCH /auth/character (đổi tên nhân vật) ----------
function doCharacterPatch(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const name = sanitizeCharName(body.name);
  if (!name) {
    return err(res, 400, 'ten_khong_hop_le', 'Tên nhân vật 1–20 ký tự.');
  }
  const users = a.users;
  const user = a.user;
  if (name === user.character.name) {
    return json(res, 200, { ok: true, character: { name: name } });
  }
  if (store.characterNameTaken(users, name, user.id)) {
    return err(res, 409, 'ten_nhan_vat_ton_tai', 'Tên nhân vật này đã có người dùng.');
  }
  // Lần đầu miễn phí; từ lần 2 tốn xu (stub — chưa trừ thật).
  const renamed = user.character.renamed_count || 0;
  if (renamed >= 1) {
    return err(res, 402, 'doi_ten_ton_xu',
      'Đổi tên lần tiếp theo tốn ' + RENAME_COST_XU + ' xu (chức năng đang phát triển).',
      { cost_xu: RENAME_COST_XU });
  }
  user.character.name = name;
  user.character.renamed_count = renamed + 1;
  user.character.updated_at = Date.now();
  store.saveUsers(users);
  return json(res, 200, { ok: true, character: { name: name } });
}

module.exports = { handleAuth };

// ---------- GET /auth/admin/stats (thống kê cho cron báo cáo) ----------
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return s[0] + '***@' + s.slice(at + 1);
}
function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 2) + '***' + s.slice(-4) : '***';
}
function adminTokenOk(req) {
  const expected = process.env.ADMIN_STATS_TOKEN || '';
  if (!expected) return 'missing';
  const got = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(got, 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return 'wrong';
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}
function doAdminStats(req, res) {
  const chk = adminTokenOk(req);
  if (chk === 'missing') {
    return err(res, 503, 'chua_cau_hinh', 'Chưa cấu hình admin token (biến môi trường ADMIN_STATS_TOKEN).');
  }
  if (chk !== 'ok') {
    return err(res, 403, 'khong_co_quyen', 'Không có quyền xem thống kê.');
  }
  const now = Date.now();
  const d1 = now - 24 * 3600 * 1000, d7 = now - 7 * 24 * 3600 * 1000;
  const users = store.loadUsers();
  const ids = Object.keys(users);
  const byIdentifier = { email: 0, phone: 0 };
  const byLevel = {};
  let new1 = 0, new7 = 0, logins1 = 0, dau7 = 0, xu = 0;
  const list = [];
  for (const id of ids) {
    const u = users[id];
    if (u.email) byIdentifier.email++;
    if (u.phone) byIdentifier.phone++;
    const lvName = (u.character && u.character.level_name) || 'Phật tử mới';
    byLevel[lvName] = (byLevel[lvName] || 0) + 1;
    if (u.created_at >= d1) new1++;
    if (u.created_at >= d7) new7++;
    if ((u.last_login_at || 0) >= d1) logins1++;
    if ((u.last_login_at || 0) >= d7) dau7++;
    xu += Math.max(0, Math.floor(Number(u.balance) || 0));
    // KHÔNG bao giờ trả password_hash / failed_attempts / locked_until.
    list.push({
      id: u.id,
      identifier_masked: u.email ? maskEmail(u.email) : maskPhone(u.phone),
      created_at: u.created_at || 0,
      last_login_at: u.last_login_at || 0,
      character_name: u.character ? u.character.name : null,
      level: (u.character && u.character.level) || 1,
      balance: u.balance || 0,
    });
  }
  list.sort((a, b) => b.created_at - a.created_at);
  return json(res, 200, {
    ok: true,
    total_users: ids.length,
    new_users_1d: new1,
    new_users_7d: new7,
    logins_1d: logins1,
    dau_7d: dau7,
    by_identifier: byIdentifier,
    by_level: byLevel,
    total_xu_circulation: xu,
    users: list,
  });
}
