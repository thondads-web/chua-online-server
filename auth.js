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
const BCRYPT_COST = 8; // Bonto free: proxy timeout ~1.1s, baseline moi request ~0.8s (ha tang) -> bcrypt phai <0.3s. Cost 8 (~0.15s) vua du; se nang lai khi chuyen hosting tot hon. Khong dung thap hon 8.
const RESET_TTL_MS = 60 * 60 * 1000; // 60 phút
const LOCK_AFTER_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 phút
const RENAME_COST_XU = 100; // stub: đổi tên lần 2+ tốn xu (chưa trừ thật)

// ---------- Hệ thống Điểm (Thọ chốt 07/11/2026) ----------
// Điểm chính là số dư Xu (user.balance). Kiếm: đăng ký +100, pháp danh/avatar
// lần đầu +30/mục, comment/like +10/ngày, share +20/ngày. Tiêu: dùng 1 dịch
// vụ -20, xem chuyên sâu -50. Mọi giao dịch ghi sổ cái (xem spec he-thong-diem).
const POINTS_USE_COST = 20;
const POINTS_VIEW_COST = 50;
const POINTS_REGISTER_BONUS = 100;
const POINTS_PROFILE_BONUS = 30;
const POINTS_EARN = { comment: 10, like: 10, share: 20 };
const POINTS_TRANSFER_MIN_STREAK_DAYS = 30; // chuyển điểm cần online liên tiếp 30 ngày
const POINTS_ACTIVE_DAYS_KEEP = 45; // giữ tối đa 45 ngày online gần nhất trên user.active_days
const PARTNER_DEFAULT_BALANCE = 1000; // tài khoản đối tác (admin tạo) có số dư mặc định 1000 điểm

// ---------- Đối tác + Vi phạm (Thọ chốt 07/11/2026) ----------
// Đối tác: dùng điểm NHƯ tài khoản thường (−20/−50), KHÔNG chuyển điểm
// (không gửi, không nhận), vẫn +10 công đức, vẫn chịu vi phạm.
// Vi phạm: admin khóa tính năng (theo thời hạn) hoặc trừ điểm (ghi sổ cái).
// Tính năng khóa được: mọi service của /points/use + 'xem-chuyen-sau' (view) + '*' (tất cả).
const LOCKABLE_FEATURES = [
  'xemque', 'laso', 'luanlaso', 'vanhan', 'ngaytot', 'tuong', 'hoptuoi',
  'datten', 'phongthuy', 'mohang', 'vochong', 'hoagiai', 'huongnha',
  'vanmenh', 'somayman', 'xinxam', 'ai-luan', 'sutrutri', 'xem-chuyen-sau', '*',
];
const FEATURE_LABELS = {
  'xemque': 'Gieo quẻ', 'laso': 'Lập lá số', 'luanlaso': 'Luận lá số',
  'vanhan': 'Vận hạn', 'ngaytot': 'Ngày tốt', 'tuong': 'Nhân tướng học',
  'hoptuoi': 'Hợp tuổi', 'datten': 'Đặt tên bé', 'phongthuy': 'Phong thủy',
  'mohang': 'Mở hàng', 'vochong': 'Vợ chồng', 'hoagiai': 'Hóa giải',
  'huongnha': 'Hướng nhà', 'vanmenh': 'Vận mệnh', 'somayman': 'Số may mắn',
  'xinxam': 'Xin xăm', 'ai-luan': 'Trợ lý AI luận giải', 'sutrutri': 'Hỏi Sư Trụ Trì',
  'xem-chuyen-sau': 'Xem chuyên sâu', '*': 'Tất cả tính năng',
};
const LOCK_DURATIONS = { 'forever': 0, '1d': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 };
const LOCK_DURATION_LABELS = { 'forever': 'vĩnh viễn', '1d': '1 ngày', '7d': '7 ngày', '30d': '30 ngày' };
function featureLabel(service) {
  return FEATURE_LABELS[String(service || '').toLowerCase()] || String(service || 'tính năng');
}
// Khóa đang còn hiệu lực của 1 tính năng (kiểm cả khóa '*' = tất cả).
// Khóa hết hạn tự hết hiệu lực theo thời gian — không cần cron dọn.
function getActiveLock(user, feature) {
  if (!user || !user.feature_locks) return null;
  const now = Date.now();
  const f = String(feature || '').toLowerCase();
  const locks = user.feature_locks;
  for (const key of [f, '*']) {
    const lk = locks[key];
    if (lk && typeof lk === 'object' && lk.reason) {
      if (!lk.expires_at || lk.expires_at > now) {
        return { feature: key, reason: lk.reason, expires_at: lk.expires_at || 0, at: lk.at || 0 };
      }
    }
  }
  return null;
}
// Danh sách khóa đang còn hiệu lực (để admin xem): [{feature, label, reason, expires_at}]
function activeLocks(user) {
  if (!user || !user.feature_locks) return [];
  const now = Date.now();
  const out = [];
  for (const key of Object.keys(user.feature_locks)) {
    const lk = user.feature_locks[key];
    if (lk && typeof lk === 'object' && lk.reason && (!lk.expires_at || lk.expires_at > now)) {
      out.push({ feature: key, label: featureLabel(key), reason: lk.reason, expires_at: lk.expires_at || 0, at: lk.at || 0 });
    }
  }
  return out;
}

// ---------- CORS ----------
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
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
// Pháp danh: 2–20 ký tự, chỉ chữ (kể cả tiếng Việt có dấu), số, khoảng trắng, gạch ngang; không chứa link.
function validPhapDanh(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 20) return false;
  if (/https?:\/\/|www\./i.test(t)) return false;
  return /^[\p{L}\p{N} \-]+$/u.test(t);
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
function publicCharacter(c) {
  c = c || {};
  return {
    name: c.name,
    phapDanh: c.phapDanh || null,
    avatar: c.avatar || 'unlock-1', // mặc định ảnh cấp 1 nếu chưa chọn
    merit: c.merit || 0,
    level: c.level || 1,
    level_name: c.level_name || 'Phật tử mới',
    updated_at: c.updated_at || 0,
  };
}
function publicUser(u) {
  return {
    id: u.id,
    email: u.email || null,
    phone: u.phone || null,
    character: publicCharacter(u.character),
    balance: u.balance || 0,
    partner: !!u.partner, // tài khoản đối tác (tạm): dùng điểm như thường, không chuyển điểm
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
    if (route === '/earn' && req.method === 'POST') return await doEarn(req, res, body);
    if (route === '/points/use' && req.method === 'POST') return doPointsUse(req, res, body);
    if (route === '/points/view' && req.method === 'POST') return doPointsView(req, res, body);
    if (route === '/points/earn' && req.method === 'POST') return doPointsEarn(req, res, body);
    if (route === '/points/transfer' && req.method === 'POST') return doPointsTransfer(req, res, body);
    if (route === '/points/status' && req.method === 'GET') return doPointsStatus(req, res);
    if (route === '/admin/stats' && req.method === 'GET') return doAdminStats(req, res);
    if (route === '/admin/users' && req.method === 'GET') return doAdminUsers(req, res);
    if (route === '/admin/user' && req.method === 'GET') return doAdminUserDetail(req, res);
    if (route === '/admin/user/lock' && req.method === 'POST') return doAdminUserLock(req, res, body);
    if (route === '/admin/user/update' && req.method === 'POST') return doAdminUserUpdate(req, res, body);
    if (route === '/admin/user/reset-link' && req.method === 'POST') return doAdminResetLink(req, res, body);
    if (route === '/admin/points' && req.method === 'POST') return doAdminPoints(req, res, body);
    if (route === '/admin/user/partner-create' && req.method === 'POST') return await doAdminPartnerCreate(req, res, body);
    if (route === '/admin/user/partner' && req.method === 'POST') return doAdminPartner(req, res, body);
    if (route === '/admin/user/violation-lock' && req.method === 'POST') return doAdminViolationLock(req, res, body);
    if (route === '/admin/user/violation-deduct' && req.method === 'POST') return doAdminViolationDeduct(req, res, body);
    if (route === '/admin/user/delete-partner' && req.method === 'POST') return doAdminDeletePartner(req, res, body);
    if (route === '/admin/log' && req.method === 'GET') return doAdminLog(req, res);
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

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);
  const id = store.newUserId();
  const now = Date.now();
  users[id] = {
    id: id,
    email: email,
    phone: phone,
    password_hash: password_hash,
    character: {
      name: charName, merit: 0, level: 1, level_name: 'Phật tử mới',
      phapDanh: null, avatar: 'unlock-1',
      updated_at: now, renamed_count: 0,
    },
    balance: 0,
    created_at: now,
    last_login_at: now,
    failed_attempts: 0,
    locked_until: 0,
  };
  store.saveUsers(users);
  // Tặng 100 điểm khi tạo tài khoản thành công (ghi sổ cái).
  const regBonus = store.addBalance(id, POINTS_REGISTER_BONUS, 'tang', 'Tạo tài khoản thành công +100 điểm');
  if (regBonus !== null) users[id].balance = regBonus;

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
  // Tài khoản bị admin khóa thì không đăng nhập được (mở khóa lại được).
  if (user && user.admin_locked) {
    return err(res, 423, 'tai_khoan_bi_khoa',
      'Tài khoản này đã bị khóa bởi quản trị. Thí chủ liên hệ hỗ trợ để mở lại.');
  }
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
    try { ok = await bcrypt.compare(password, user.password_hash); } catch (e) { ok = false; }
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
  recordActiveDay(user); // ghi ngày online hôm nay (Asia/Saigon)
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
  recordActiveDay(a.user); // ghi ngày online hôm nay (Asia/Saigon)
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
    out.dev_note = 'Email chưa cấu hình (thiếu BREVO_API_KEY, RESEND_API_KEY hoặc GMAIL_APP_PASSWORD) — link đặt lại đã ghi vào server log, chưa gửi email thật.';
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

  user.password_hash = await bcrypt.hash(newPw, BCRYPT_COST);
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
    character: publicCharacter(c),
  });
}

// ---------- PATCH /auth/character ----------
// Cập nhật nhân vật: đổi tên (luồng cũ) + đặt pháp danh + chọn ảnh đại diện mở khóa theo cấp.
// Body có thể chứa 1 hoặc nhiều trường: {name, phapDanh, avatar}.
// - phapDanh: 2–20 ký tự, chỉ chữ/số/khoảng trắng/gạch ngang, không chứa link.
// - avatar: id dạng unlock-1 … unlock-10; chỉ được chọn ảnh có cấp mở khóa ≤ cấp hiện tại,
//   chọn ảnh chưa mở khóa → 403.
function doCharacterPatch(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const users = a.users;
  const user = a.user;
  const c = user.character;
  const hasName = body.name !== undefined && body.name !== null && String(body.name).trim() !== '';
  const hasPhapDanh = body.phapDanh !== undefined && body.phapDanh !== null && String(body.phapDanh).trim() !== '';
  const hasAvatar = body.avatar !== undefined && body.avatar !== null && String(body.avatar).trim() !== '';
  if (!hasName && !hasPhapDanh && !hasAvatar) {
    return err(res, 400, 'khong_co_gi_thay_doi', 'Không có thông tin nào để cập nhật.');
  }
  let changed = false;
  let phapDanhBonus = false; // đặt pháp danh lần đầu -> +30 điểm
  let avatarBonus = false; // đổi avatar lần đầu (khác unlock-1) -> +30 điểm
  // 1) Đổi tên nhân vật (luồng cũ: lần đầu miễn phí, từ lần 2 tốn xu — stub).
  if (hasName) {
    const name = sanitizeCharName(body.name);
    if (!name) {
      return err(res, 400, 'ten_khong_hop_le', 'Tên nhân vật 1–20 ký tự.');
    }
    if (name !== c.name) {
      if (store.characterNameTaken(users, name, user.id)) {
        return err(res, 409, 'ten_nhan_vat_ton_tai', 'Tên nhân vật này đã có người dùng.');
      }
      const renamed = c.renamed_count || 0;
      if (renamed >= 1) {
        return err(res, 402, 'doi_ten_ton_xu',
          'Đổi tên lần tiếp theo tốn ' + RENAME_COST_XU + ' xu (chức năng đang phát triển).',
          { cost_xu: RENAME_COST_XU });
      }
      c.name = name;
      c.renamed_count = renamed + 1;
      changed = true;
    }
  }
  // 2) Đặt pháp danh (hiển thị cùng bình luận thay cho tên nhân vật).
  if (hasPhapDanh) {
    const pd = String(body.phapDanh).trim();
    if (!validPhapDanh(pd)) {
      return err(res, 400, 'phap_danh_khong_hop_le', 'Pháp danh 2–20 ký tự, chỉ chữ, số, khoảng trắng và gạch ngang, không chứa link.');
    }
    // Lần đầu đặt pháp danh (trước đó chưa có) -> thưởng 30 điểm, chỉ 1 lần.
    if (!c.phapDanh && !user.points_phapdanh_done) phapDanhBonus = true;
    c.phapDanh = pd;
    changed = true;
  }
  // 3) Chọn ảnh đại diện (chỉ ảnh đã mở khóa theo cấp).
  if (hasAvatar) {
    const av = String(body.avatar).trim();
    const m = /^unlock-([1-9]|10)$/.exec(av);
    if (!m) {
      return err(res, 400, 'avatar_khong_hop_le', 'Ảnh đại diện không hợp lệ.');
    }
    const needLevel = parseInt(m[1], 10);
    const curLevel = c.level || 1;
    if (needLevel > curLevel) {
      return err(res, 403, 'avatar_chua_mo_khoa',
        'Ảnh này mở khóa ở cấp ' + needLevel + ', thí chủ đang ở cấp ' + curLevel + '.');
    }
    // Lần đầu đổi avatar (từ ảnh mặc định unlock-1 sang ảnh khác) -> +30 điểm, chỉ 1 lần.
    const prevAvatar = c.avatar || 'unlock-1';
    if (prevAvatar === 'unlock-1' && av !== 'unlock-1' && !user.points_avatar_done) avatarBonus = true;
    c.avatar = av;
    changed = true;
  }
  if (changed) {
    c.updated_at = Date.now();
    store.saveUsers(users);
    // Thưởng điểm hồ sơ lần đầu (+30/mục). Cộng SAU khi lưu thay đổi nhân vật
    // (addBalance nạp lại file), rồi lưu lại cờ + số dư mới để không bị ghi đè.
    // Cờ chỉ đặt khi cộng điểm thành công (không mất thưởng nếu cộng lỗi).
    let gained = 0;
    if (phapDanhBonus) {
      const after = store.addBalance(user.id, POINTS_PROFILE_BONUS, 'tang', 'Đặt pháp danh lần đầu +30 điểm');
      if (after !== null) { user.balance = after; user.points_phapdanh_done = true; gained += POINTS_PROFILE_BONUS; }
    }
    if (avatarBonus) {
      const after = store.addBalance(user.id, POINTS_PROFILE_BONUS, 'tang', 'Đổi ảnh đại diện lần đầu +30 điểm');
      if (after !== null) { user.balance = after; user.points_avatar_done = true; gained += POINTS_PROFILE_BONUS; }
    }
    if (gained > 0) {
      store.saveUsers(users);
      return json(res, 200, { ok: true, character: publicCharacter(c), points_gained: gained, balance: user.balance || 0 });
    }
  }
  return json(res, 200, { ok: true, character: publicCharacter(c) });
}

module.exports = { handleAuth, getAuthUser };

// ---------- POST /auth/earn — cộng kinh nghiệm (công đức) khi dùng công cụ ----------
// Mỗi lần tài khoản đã đăng nhập dùng 1 công cụ (gieo quẻ, đặt tên, xem lá số...)
// thì được +XP_PER_USE công đức, lên cấp nhân vật theo bảng MERIT_LEVELS.
// Chống cày điểm: 30 giây mới được cộng 1 lần + tối đa 50 lần/giờ/tài khoản.
// Trả về merit/level hiện tại + leveled_up để web hiện bảng thông báo 3 giây.
const XP_PER_USE = 10;
const XP_COOLDOWN_MS = 30 * 1000;
const XP_HOURLY_CAP = 50;
async function doEarn(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const service = String(body.service || '').trim().slice(0, 50);
  if (!/^[a-z0-9_-]{1,50}$/i.test(service)) {
    return err(res, 400, 'dich_vu_khong_hop_le', 'Tên dịch vụ chưa đúng.');
  }
  const users = a.users;
  const user = a.user;
  const now = Date.now();
  // Chống spam: 30 giây mới cộng 1 lần (theo tài khoản).
  const lastAt = Math.floor(Number(user.xp_last_at) || 0);
  if (now - lastAt < XP_COOLDOWN_MS) {
    return err(res, 429, 'cong_diem_qua_nhanh',
      'Thí chủ thao tác quá nhanh, thử lại sau ' + Math.ceil((XP_COOLDOWN_MS - (now - lastAt)) / 1000) + ' giây.',
      { retry_after_giay: Math.ceil((XP_COOLDOWN_MS - (now - lastAt)) / 1000) });
  }
  // Chống cày: tối đa 50 lần/giờ/tài khoản.
  const rlS = rateLimited('earn:user:' + user.id, XP_HOURLY_CAP, 3600 * 1000);
  if (rlS) {
    res.setHeader('Retry-After', rlS);
    return err(res, 429, 'qua_nhieu_yeu_cau', 'Thí chủ đã nhận đủ điểm trong giờ này, thử lại sau.');
  }
  const c = user.character;
  const prevLevel = c.level || 1;
  const prevMerit = Math.max(0, Math.floor(Number(c.merit) || 0));
  const merit = prevMerit + XP_PER_USE;
  const lv = store.levelFromMerit(merit);
  c.merit = merit;
  c.level = lv.level;
  c.level_name = lv.level_name;
  c.updated_at = now;
  user.xp_last_at = now;
  store.saveUsers(users);
  return json(res, 200, {
    ok: true,
    xp_gained: XP_PER_USE,
    service: service,
    merit: merit,
    level: lv.level,
    level_name: lv.level_name,
    prev_level: prevLevel,
    leveled_up: lv.level > prevLevel,
    character: publicCharacter(c),
  });
}

// ---------- Hệ thống Điểm: dùng / xem / kiếm ----------
// Ngày theo giờ Asia/Saigon (UTC+7, không đổi giờ mùa hè).
function saigonDate(ts) {
  return new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
function validServiceName(s) {
  return /^[a-z0-9_-]{1,50}$/i.test(s);
}
// Đã nhận điểm tương tác loại này trong ngày (giờ Asia/Saigon) chưa?
// Kiểm tra bằng sổ cái: tìm giao dịch 'tang' có lý do 'Tương tác <kind> ...'.
function pointsEarnedToday(userId, kind) {
  const today = saigonDate(Date.now());
  const prefix = 'Tương tác ' + kind + ' ';
  const entries = store.loadLedger();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.user_id !== userId) continue;
    if (e.type === 'tang' && typeof e.reason === 'string' && e.reason.indexOf(prefix) === 0
      && saigonDate(e.at) === today) return true;
  }
  return false;
}

// POST /auth/points/use {service} — trừ 20 điểm để dùng 1 dịch vụ.
function doPointsUse(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const service = String(body.service || '').trim().slice(0, 50);
  if (!validServiceName(service)) {
    return err(res, 400, 'dich_vu_khong_hop_le', 'Tên dịch vụ chưa đúng.');
  }
  const balance = Math.max(0, Math.floor(Number(a.user.balance) || 0));
  // Vi phạm: tính năng bị khóa thì chặn TRƯỚC cả kiểm tra điểm (đối tác cũng bị chặn).
  const lock = getActiveLock(a.user, service);
  if (lock) {
    return err(res, 403, 'tinh_nang_bi_khoa',
      'Tính năng ' + featureLabel(service) + ' đang tạm khóa' + (lock.expires_at ? ' đến ' + new Date(lock.expires_at).toLocaleDateString('vi-VN') : ' vĩnh viễn') + '.',
      { feature: service, reason: lock.reason, expires_at: lock.expires_at || 0 });
  }
  // Đối tác dùng điểm NHƯ tài khoản thường (−20/lần, trừ từ số dư 1000) — KHÔNG bypass (Thọ đơn giản hoá 21:47).
  if (balance < POINTS_USE_COST) {
    return err(res, 402, 'khong_du_diem',
      'Thí chủ còn ' + balance + ' điểm, dùng dịch vụ này cần ' + POINTS_USE_COST + ' điểm.',
      { balance: balance });
  }
  // Kiểm tra số dư + trừ trong cùng một lượt xử lý, không có await xen giữa.
  const after = store.addBalance(a.user.id, -POINTS_USE_COST, 'tieu', 'Dùng dịch vụ ' + service + ' -20 điểm');
  if (after === null) {
    return err(res, 402, 'khong_du_diem', 'Thí chủ không đủ điểm để dùng dịch vụ này.', { balance: balance });
  }
  return json(res, 200, { ok: true, balance: after });
}

// POST /auth/points/view {article} — trừ 50 điểm để xem 1 bài chuyên sâu.
function doPointsView(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const article = String(body.article || '').trim().slice(0, 50);
  if (!validServiceName(article)) {
    return err(res, 400, 'bai_viet_khong_hop_le', 'Tên bài viết chưa đúng.');
  }
  const balance = Math.max(0, Math.floor(Number(a.user.balance) || 0));
  // Vi phạm: mục chuyên sâu bị khóa thì chặn trước (đối tác cũng bị chặn).
  const lock = getActiveLock(a.user, 'xem-chuyen-sau');
  if (lock) {
    return err(res, 403, 'tinh_nang_bi_khoa',
      'Tính năng ' + featureLabel('xem-chuyen-sau') + ' đang tạm khóa' + (lock.expires_at ? ' đến ' + new Date(lock.expires_at).toLocaleDateString('vi-VN') : ' vĩnh viễn') + '.',
      { feature: 'xem-chuyen-sau', reason: lock.reason, expires_at: lock.expires_at || 0 });
  }
  // Đối tác dùng điểm NHƯ tài khoản thường (−50/lần, trừ từ số dư 1000) — KHÔNG bypass (Thọ đơn giản hoá 21:47).
  if (balance < POINTS_VIEW_COST) {
    return err(res, 402, 'khong_du_diem',
      'Thí chủ còn ' + balance + ' điểm, xem bài chuyên sâu cần ' + POINTS_VIEW_COST + ' điểm.',
      { balance: balance });
  }
  const after = store.addBalance(a.user.id, -POINTS_VIEW_COST, 'tieu', 'Xem chuyên sâu ' + article + ' -50 điểm');
  if (after === null) {
    return err(res, 402, 'khong_du_diem', 'Thí chủ không đủ điểm để xem bài này.', { balance: balance });
  }
  return json(res, 200, { ok: true, balance: after });
}

// POST /auth/points/earn {kind} — cộng điểm tương tác, mỗi loại 1 lần/ngày.
function doPointsEarn(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const kind = String(body.kind || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(POINTS_EARN, kind)) {
    return err(res, 400, 'loai_tuong_tac_khong_hop_le', 'Loại tương tác phải là comment, like hoặc share.');
  }
  if (pointsEarnedToday(a.user.id, kind)) {
    return err(res, 429, 'het_luot_hom_nay', 'Thí chủ đã nhận điểm ' + kind + ' hôm nay rồi, mai quay lại nhé.', { kind: kind });
  }
  const gained = POINTS_EARN[kind];
  const after = store.addBalance(a.user.id, gained, 'tang', 'Tương tác ' + kind + ' +' + gained + ' điểm');
  if (after === null) {
    return err(res, 500, 'loi_he_thong', 'Hệ thống bận, thí chủ thử lại sau.');
  }
  return json(res, 200, { ok: true, gained: gained, balance: after });
}

// ---------- Chuyển điểm (Thọ chốt 07/11/2026, mục 8 spec) ----------
// Ghi ngày online hôm nay (Asia/Saigon) vào user.active_days (mảng, tối đa
// 45 ngày gần nhất, không trùng ngày). Gọi trong doLogin và doMe.
function recordActiveDay(user) {
  if (!user) return;
  const today = saigonDate(Date.now());
  let days = Array.isArray(user.active_days)
    ? user.active_days.filter((d) => typeof d === 'string')
    : [];
  if (days.indexOf(today) < 0) days.push(today);
  if (days.length > POINTS_ACTIVE_DAYS_KEEP) days = days.slice(-POINTS_ACTIVE_DAYS_KEEP);
  user.active_days = days;
}
// Chuỗi ngày online liên tiếp tính đến hôm nay. Hôm nay được tính vì người
// dùng đang online lúc gọi (dù chưa kịp ghi vào active_days).
function activeStreak(user) {
  const days = new Set(Array.isArray(user && user.active_days) ? user.active_days : []);
  const today = saigonDate(Date.now());
  days.add(today);
  let streak = 0;
  let d = new Date(today + 'T00:00:00Z');
  while (!isNaN(d.getTime())) {
    const key = d.toISOString().slice(0, 10);
    if (!days.has(key)) break;
    streak += 1;
    d = new Date(d.getTime() - 24 * 3600 * 1000);
  }
  return streak;
}
// Tìm tài khoản nhận điểm theo thứ tự: email → SĐT → tên nhân vật
// (tên nhân vật khớp không phân biệt hoa/thường).
function findTransferRecipient(users, toRaw) {
  const to = String(toRaw || '').trim();
  if (!to) return null;
  if (store.validEmail(to)) {
    const u = store.findByEmail(users, to.toLowerCase());
    if (u) return u;
  }
  const phone = store.normalizePhone(to);
  if (phone) {
    const u = store.findByPhone(users, phone);
    if (u) return u;
  }
  const low = to.toLowerCase();
  for (const id of Object.keys(users)) {
    const u = users[id];
    const name = u && u.character && u.character.name;
    if (typeof name === 'string' && name.toLowerCase() === low) return u;
  }
  return null;
}
function transferLabel(u) {
  if (u && u.character && u.character.name) return u.character.name;
  if (u && u.email) return u.email;
  if (u && u.phone) return u.phone;
  return 'thí chủ';
}

// POST /auth/points/transfer {to, amount} — chuyển điểm cho tài khoản khác.
function doPointsTransfer(req, res, body) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const to = String(body.to || '').trim().slice(0, 100);
  const amount = Math.floor(Number(body.amount));
  if (!to) {
    return err(res, 400, 'thieu_nguoi_nhan', 'Thí chủ chưa nhập tài khoản nhận điểm.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return err(res, 400, 'so_diem_khong_hop_le', 'Số điểm chuyển phải là số nguyên dương.');
  }
  // Đối tác KHÔNG chuyển điểm được (tài khoản tạm, chỉ để test/trải nghiệm).
  // Kiểm bên gửi trước cả streak (luật cứng, không phụ thuộc số ngày online).
  if (a.user.partner) {
    return err(res, 403, 'doi_tac_khong_chuyen_diem',
      'Tài khoản đối tác (tạm, chỉ để test/trải nghiệm) không chuyển điểm được.',
      { doi_tac: 'nguoi_gui' });
  }
  // Điều kiện mở chuyển: online liên tiếp 30 ngày (tính đến hôm nay).
  const streak = activeStreak(a.user);
  if (streak < POINTS_TRANSFER_MIN_STREAK_DAYS) {
    return err(res, 403, 'chua_du_30_ngay',
      'Thí chủ cần online liên tiếp 30 ngày mới chuyển được điểm. Hiện tại đã liên tiếp ' + streak + ' ngày.',
      { streak: streak, con_thieu: POINTS_TRANSFER_MIN_STREAK_DAYS - streak });
  }
  const recipient = findTransferRecipient(a.users, to);
  if (!recipient) {
    return err(res, 404, 'khong_tim_thay_nguoi_nhan', 'Không tìm thấy tài khoản nhận điểm.');
  }
  // Đối tác cũng KHÔNG NHẬN điểm chuyển (kiểm sau streak theo đúng thứ tự
  // hợp đồng chuyển điểm: streak → tra người nhận → kiểm đối tác).
  if (recipient.partner) {
    return err(res, 403, 'doi_tac_khong_chuyen_diem',
      'Không chuyển điểm cho tài khoản đối tác (tài khoản tạm, chỉ để test/trải nghiệm).',
      { doi_tac: 'nguoi_nhan' });
  }
  if (recipient.id === a.user.id) {
    return err(res, 400, 'khong_chuyen_cho_chinh_minh', 'Không chuyển điểm cho chính mình.');
  }
  const balance = Math.max(0, Math.floor(Number(a.user.balance) || 0));
  if (balance < amount) {
    return err(res, 402, 'khong_du_diem',
      'Thí chủ còn ' + balance + ' điểm, không đủ để chuyển ' + amount + ' điểm.',
      { balance: balance });
  }
  // Kiểm số dư + trừ trong cùng một lượt xử lý, không có await xen giữa.
  const recvLabel = transferLabel(recipient);
  const after = store.addBalance(a.user.id, -amount, 'tieu', 'Chuyển điểm cho ' + recvLabel + ' -' + amount + ' điểm');
  if (after === null) {
    return err(res, 402, 'khong_du_diem', 'Thí chủ không đủ điểm để chuyển.', { balance: balance });
  }
  const recvAfter = store.addBalance(recipient.id, amount, 'tang', 'Nhận điểm từ ' + transferLabel(a.user) + ' +' + amount + ' điểm');
  if (recvAfter === null) {
    // Hiếm: cộng cho người nhận lỗi sau khi đã trừ người gửi → hoàn lại.
    store.addBalance(a.user.id, amount, 'tang', 'Hoàn điểm do chuyển cho ' + recvLabel + ' lỗi');
    return err(res, 500, 'loi_he_thong', 'Hệ thống bận, thí chủ thử lại sau.');
  }
  return json(res, 200, { ok: true, balance: after, streak: streak, to_name: recvLabel });
}

// GET /auth/points/status — số dư + chuỗi online + trạng thái mở chuyển.
function doPointsStatus(req, res) {
  const a = getAuthUser(req);
  if (!a) return err(res, 401, 'chua_dang_nhap', 'Thí chủ chưa đăng nhập.');
  const streak = activeStreak(a.user);
  const unlocked = streak >= POINTS_TRANSFER_MIN_STREAK_DAYS;
  return json(res, 200, {
    ok: true,
    balance: Math.max(0, Math.floor(Number(a.user.balance) || 0)),
    partner: !!a.user.partner,
    streak: streak,
    transfer_unlocked: unlocked,
    days_left: unlocked ? 0 : (POINTS_TRANSFER_MIN_STREAK_DAYS - streak),
  });
}

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

// ---------- Trang quản trị (admin.html) ----------
// Mọi endpoint dưới đây yêu cầu header x-admin-token (ADMIN_STATS_TOKEN).
// Không bao giờ trả password_hash / IP. Mọi thao tác đổi dữ liệu ghi admin-log.

function adminGuard(req, res) {
  const chk = adminTokenOk(req);
  if (chk === 'missing') {
    err(res, 503, 'chua_cau_hinh', 'Chưa cấu hình admin token (biến môi trường ADMIN_STATS_TOKEN).');
    return false;
  }
  if (chk !== 'ok') {
    err(res, 403, 'khong_co_quyen', 'Không có quyền quản trị.');
    return false;
  }
  return true;
}

// Dòng hồ sơ cho danh sách (email/SĐT che bớt, không lộ dữ liệu nhạy cảm).
function adminUserSummary(u) {
  const c = u.character || {};
  return {
    id: u.id,
    identifier_masked: u.email ? maskEmail(u.email) : maskPhone(u.phone),
    name: c.name || null,
    phapDanh: c.phapDanh || null,
    avatar: c.avatar || 'unlock-1',
    level: c.level || 1,
    level_name: c.level_name || 'Phật tử mới',
    merit: c.merit || 0,
    balance: u.balance || 0,
    created_at: u.created_at || 0,
    last_login_at: u.last_login_at || 0,
    locked: !!u.admin_locked,
    lock_reason: u.admin_lock_reason || null,
    partner: !!u.partner,
    active_locks: activeLocks(u), // khóa tính năng đang còn hiệu lực (đã hết hạn tự hết)
  };
}

// GET /auth/admin/users?search=&level= — liệt kê hồ sơ (mới nhất trước).
function doAdminUsers(req, res) {
  if (!adminGuard(req, res)) return;
  let q = {};
  try { q = new URL(req.url, 'http://localhost').searchParams; } catch (e) {}
  const search = (q.get('search') || '').trim().toLowerCase();
  const level = parseInt(q.get('level') || '0', 10) || 0;
  const users = store.loadUsers();
  let list = Object.keys(users).map((id) => users[id]);
  if (search) {
    list = list.filter((u) => {
      const hay = [
        (u.character && u.character.name) || '',
        (u.character && u.character.phapDanh) || '',
        u.email || '', u.phone || '', u.id || '',
      ].join(' ').toLowerCase();
      return hay.indexOf(search) !== -1;
    });
  }
  if (level >= 1 && level <= 10) list = list.filter((u) => ((u.character && u.character.level) || 1) === level);
  list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return json(res, 200, { ok: true, total: list.length, users: list.map(adminUserSummary) });
}

// GET /auth/admin/user?id= — chi tiết 1 hồ sơ + sổ cái xu + nhật ký admin.
function doAdminUserDetail(req, res) {
  if (!adminGuard(req, res)) return;
  let q = {};
  try { q = new URL(req.url, 'http://localhost').searchParams; } catch (e) {}
  const id = String(q.get('id') || '');
  const users = store.loadUsers();
  const u = users[id];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const c = u.character || {};
  return json(res, 200, {
    ok: true,
    user: Object.assign(adminUserSummary(u), {
      renamed_count: c.renamed_count || 0,
      character_updated_at: c.updated_at || 0,
      failed_attempts: u.failed_attempts || 0,
      temp_locked_until: u.locked_until || 0,
      feature_locks: u.feature_locks || {},
    }),
    ledger: store.ledgerForUser(u.id, 20),
    admin_log: store.adminLogForUser(u.id, 20),
    // Lịch sử vi phạm + đối tác của tài khoản (mới nhất trước).
    violations: store.adminLogForUser(u.id, 50).filter((e) => e && (
      e.action === 'violation_lock' || e.action === 'violation_unlock' ||
      e.action === 'violation_deduct' || e.action === 'partner_set' ||
      e.action === 'partner_unset' || e.action === 'partner_create')),
  });
}

// POST /auth/admin/user/lock {user_id, locked, reason} — khoá/mở khoá tài khoản.
// Khi khoá: hủy toàn bộ session (người dùng bị đăng xuất ngay).
function doAdminUserLock(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const locked = body.locked === true;
  const reason = String(body.reason || '').trim().slice(0, 200);
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const before = !!u.admin_locked;
  if (before === locked) {
    return json(res, 200, { ok: true, locked: locked, changed: false, user: adminUserSummary(u) });
  }
  u.admin_locked = locked;
  u.admin_lock_reason = locked ? (reason || 'Khóa bởi quản trị') : null;
  u.admin_lock_at = locked ? Date.now() : null;
  store.saveUsers(users);
  if (locked) {
    const sessions = store.loadSessions();
    let changed = false;
    for (const k of Object.keys(sessions)) {
      if (sessions[k] && sessions[k].user_id === userId) { delete sessions[k]; changed = true; }
    }
    if (changed) store.saveSessions(sessions);
  }
  store.appendAdminLog({
    action: locked ? 'user_lock' : 'user_unlock', user_id: userId,
    target: (u.character && u.character.name) || userId,
    detail: locked ? 'Khóa tài khoản' : 'Mở khóa tài khoản',
    before: before, after: locked, reason: reason,
  });
  return json(res, 200, { ok: true, locked: locked, changed: true, user: adminUserSummary(u) });
}

// POST /auth/admin/user/update {user_id, name?, phapDanh?} — sửa tên nhân vật / pháp danh.
// Admin được sửa không giới hạn số lần (khác luồng người dùng tự đổi). Đổi tên
// nhân vật thì dời điểm game (key = tên) sang tên mới để Bảng Vàng không mất điểm.
function doAdminUserUpdate(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const c = u.character || {};
  const hasName = body.name !== undefined && body.name !== null && String(body.name).trim() !== '';
  const hasPhapDanh = body.phapDanh !== undefined && body.phapDanh !== null && String(body.phapDanh).trim() !== '';
  if (!hasName && !hasPhapDanh) {
    return err(res, 400, 'khong_co_gi_thay_doi', 'Không có thông tin nào để cập nhật.');
  }
  const before = { name: c.name || null, phapDanh: c.phapDanh || null };
  let newName = null, newPhapDanh = null;
  if (hasName) {
    newName = sanitizeCharName(body.name);
    if (!newName) return err(res, 400, 'ten_khong_hop_le', 'Tên nhân vật 1–20 ký tự.');
    if (newName !== c.name && store.characterNameTaken(users, newName, userId)) {
      return err(res, 409, 'ten_nhan_vat_ton_tai', 'Tên nhân vật này đã có người dùng.');
    }
  }
  if (hasPhapDanh) {
    newPhapDanh = String(body.phapDanh).trim();
    if (!validPhapDanh(newPhapDanh)) {
      return err(res, 400, 'phap_danh_khong_hop_le', 'Pháp danh 2–20 ký tự, chỉ chữ, số, khoảng trắng và gạch ngang, không chứa link.');
    }
  }
  if (newName && newName !== c.name) {
    const oldName = c.name;
    c.name = newName;
    store.migrateGameMeritName(oldName, newName);
  }
  if (newPhapDanh) c.phapDanh = newPhapDanh;
  c.updated_at = Date.now();
  store.saveUsers(users);
  store.appendAdminLog({
    action: 'user_update', user_id: userId, target: c.name || userId,
    detail: 'Sửa hồ sơ', before: before, after: { name: c.name, phapDanh: c.phapDanh || null },
  });
  return json(res, 200, { ok: true, user: adminUserSummary(u) });
}

// POST /auth/admin/user/reset-link {user_id} — tạo link đặt lại mật khẩu 1 lần
// (hết hạn 60 phút). Admin tự gửi link cho người dùng qua kênh riêng.
function doAdminResetLink(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const token = crypto.randomBytes(32).toString('hex');
  const resets = store.loadResets();
  resets[store.sha256hex(token)] = {
    user_id: userId, email: u.email || null, phone: u.phone || null,
    expires_at: Date.now() + 60 * 60 * 1000, used: false, created_by_admin: true,
  };
  store.saveResets(resets);
  store.appendAdminLog({
    action: 'user_reset_link', user_id: userId, target: (u.character && u.character.name) || userId,
    detail: 'Tạo link đặt lại mật khẩu (1 lần, 60 phút)',
  });
  return json(res, 200, { ok: true, reset_link: WEB_BASE + '/?reset=' + token, expires_minutes: 60 });
}

// POST /auth/admin/points {user_id, merit_delta?, xu_delta?, reason}
// Cộng/trừ công đức và/hoặc xu. Cộng công đức tính lại cấp bằng levelFromMerit.
// Công đức không âm. Ghi sổ cái xu + nhật ký admin (trước/sau) để đối soát.
function doAdminPoints(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const reason = String(body.reason || '').trim();
  const meritDelta = Number(body.merit_delta) || 0;
  const xuDelta = Number(body.xu_delta) || 0;
  if (!reason) return err(res, 400, 'thieu_ly_do', 'Cần nhập lý do cộng/trừ điểm.');
  if (reason.length > 200) return err(res, 400, 'ly_do_quai_dai', 'Lý do tối đa 200 ký tự.');
  if (!Number.isInteger(meritDelta) || Math.abs(meritDelta) > 10000) {
    return err(res, 400, 'diem_khong_hop_le', 'Điểm công đức mỗi lần từ -10000 đến 10000.');
  }
  if (!Number.isInteger(xuDelta) || Math.abs(xuDelta) > 100000) {
    return err(res, 400, 'xu_khong_hop_le', 'Xu mỗi lần từ -100000 đến 100000.');
  }
  if (meritDelta === 0 && xuDelta === 0) {
    return err(res, 400, 'khong_co_gi_thay_doi', 'Điểm và xu đều bằng 0 — không có gì để cập nhật.');
  }
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const c = u.character || {};
  const before = { merit: c.merit || 0, level: c.level || 1, level_name: c.level_name || 'Phật tử mới', balance: u.balance || 0 };
  if (meritDelta !== 0) {
    const newMerit = Math.max(0, (c.merit || 0) + meritDelta);
    c.merit = newMerit;
    const lv = store.levelFromMerit(newMerit);
    c.level = lv.level;
    c.level_name = lv.level_name;
    c.updated_at = Date.now();
  }
  if (xuDelta !== 0) {
    if (xuDelta < 0 && (u.balance || 0) + xuDelta < 0) {
      return err(res, 400, 'xu_khong_du', 'Số xu hiện có không đủ để trừ ' + Math.abs(xuDelta) + ' xu.');
    }
    // Cộng/trừ xu trực tiếp trên bản users đang giữ (addBalance nạp lại file
    // riêng nên không dùng được ở đây — sẽ ghi đè điểm công đức vừa đổi).
    u.balance = (u.balance || 0) + xuDelta;
    store.appendLedger({
      user_id: userId, type: 'tang', amount: xuDelta, balance_after: u.balance,
      reason: '[admin] ' + reason, at: Date.now(),
    });
  }
  store.saveUsers(users);
  const after = { merit: c.merit || 0, level: c.level || 1, level_name: c.level_name || 'Phật tử mới', balance: u.balance || 0 };
  store.appendAdminLog({
    action: 'points_adjust', user_id: userId, target: c.name || userId,
    detail: 'Điều chỉnh điểm: công đức ' + (meritDelta >= 0 ? '+' : '') + meritDelta +
      ', xu ' + (xuDelta >= 0 ? '+' : '') + xuDelta,
    before: before, after: after, reason: reason,
  });
  return json(res, 200, { ok: true, user: adminUserSummary(u) });
}

// ---------- Đối tác + Vi phạm (admin) ----------
// POST /auth/admin/user/partner-create {email?, phone?, password, name?}
// Tạo tài khoản ĐỐI TÁC mới (tạm, chỉ để test/trải nghiệm hệ thống): số dư
// mặc định PARTNER_DEFAULT_BALANCE (1000) điểm, ghi sổ cái. Admin tự giữ
// mật khẩu đã đặt để đưa cho đối tác. Không chịu rate-limit đăng ký thường.
async function doAdminPartnerCreate(req, res, body) {
  if (!adminGuard(req, res)) return;
  let email = String(body.email || '').trim().toLowerCase() || null;
  let phone = body.phone != null ? store.normalizePhone(body.phone) : null;
  const password = String(body.password || '');
  if (body.phone != null && !phone) {
    return err(res, 400, 'so_dien_thoai_khong_hop_le', 'Số điện thoại chưa đúng (đầu 09/03/07/08/05, 10 số).');
  }
  if (!email && !phone) {
    return err(res, 400, 'thieu_thong_tin', 'Cần email hoặc số điện thoại để tạo tài khoản đối tác.');
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
  let charName = sanitizeCharName(body.name);
  if (!charName) charName = store.randomCharacterName(users);
  else if (store.characterNameTaken(users, charName)) {
    return err(res, 409, 'ten_nhan_vat_ton_tai', 'Tên nhân vật này đã có người dùng.');
  }
  const password_hash = await bcrypt.hash(password, BCRYPT_COST);
  const id = store.newUserId();
  const now = Date.now();
  users[id] = {
    id: id,
    email: email,
    phone: phone,
    password_hash: password_hash,
    character: {
      name: charName, merit: 0, level: 1, level_name: 'Phật tử mới',
      phapDanh: null, avatar: 'unlock-1',
      updated_at: now, renamed_count: 0,
    },
    balance: PARTNER_DEFAULT_BALANCE,
    partner: true, // tài khoản đối tác (tạm): dùng điểm như thường, không chuyển điểm — dùng xong admin xoá
    created_at: now,
    last_login_at: 0,
    failed_attempts: 0,
    locked_until: 0,
  };
  store.saveUsers(users);
  store.appendLedger({
    user_id: id, type: 'tang', amount: PARTNER_DEFAULT_BALANCE,
    balance_after: PARTNER_DEFAULT_BALANCE,
    reason: 'Tạo tài khoản đối tác +' + PARTNER_DEFAULT_BALANCE + ' điểm', at: now,
  });
  store.appendAdminLog({
    action: 'partner_create', user_id: id, target: charName,
    detail: 'Tạo tài khoản đối tác (tạm, để test/trải nghiệm) — số dư mặc định ' + PARTNER_DEFAULT_BALANCE + ' điểm',
    after: { partner: true, balance: PARTNER_DEFAULT_BALANCE },
  });
  return json(res, 201, { ok: true, user: adminUserSummary(users[id]) });
}

// POST /auth/admin/user/partner {user_id, partner} — bật/tắt cờ đối tác.
// Bật đối tác cho tài khoản có sẵn: nếu số dư < 1000 thì nâng lên 1000 (ghi
// sổ cái phần chênh lệch); số dư đã ≥1000 thì giữ nguyên. Tắt đối tác: giữ
// nguyên số dư. Tài khoản thường vẫn KHÔNG được xoá vĩnh viễn.
function doAdminPartner(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const partner = body.partner === true;
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const before = { partner: !!u.partner, balance: u.balance || 0 };
  if (before.partner === partner) {
    return json(res, 200, { ok: true, partner: partner, changed: false, user: adminUserSummary(u) });
  }
  u.partner = partner;
  let toppedUp = 0;
  if (partner && (u.balance || 0) < PARTNER_DEFAULT_BALANCE) {
    toppedUp = PARTNER_DEFAULT_BALANCE - (u.balance || 0);
    u.balance = PARTNER_DEFAULT_BALANCE;
    // Ghi sổ cái trực tiếp (addBalance nạp lại file riêng sẽ ghi đè cờ partner).
    store.appendLedger({
      user_id: userId, type: 'tang', amount: toppedUp, balance_after: u.balance,
      reason: 'Nâng số dư lên ' + PARTNER_DEFAULT_BALANCE + ' điểm (tài khoản đối tác)', at: Date.now(),
    });
  }
  store.saveUsers(users);
  store.appendAdminLog({
    action: partner ? 'partner_set' : 'partner_unset', user_id: userId,
    target: (u.character && u.character.name) || userId,
    detail: partner
      ? 'Bật tài khoản đối tác (tạm, dùng điểm như thường; không chuyển điểm)' + (toppedUp > 0 ? ', nâng số dư +' + toppedUp + ' điểm lên ' + PARTNER_DEFAULT_BALANCE : '')
      : 'Tắt tài khoản đối tác (dùng điểm như tài khoản thường)',
    before: before, after: { partner: partner, balance: u.balance || 0 },
  });
  return json(res, 200, { ok: true, partner: partner, changed: true, topped_up: toppedUp, user: adminUserSummary(u) });
}

// POST /auth/admin/user/violation-lock {user_id, action: 'lock'|'unlock',
//   features: [...], duration?: 'forever'|'1d'|'7d'|'30d', reason?}
// Khóa 1 hoặc nhiều tính năng (hoặc '*' = tất cả). Khóa cần lý do bắt buộc.
// Mở khóa sớm: action 'unlock', không cần lý do. Khóa hết hạn tự hết hiệu
// lực theo thời gian (không cần cron dọn). Mọi thao tác ghi nhật ký admin.
function doAdminViolationLock(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const action = String(body.action || 'lock').trim().toLowerCase();
  const featuresRaw = Array.isArray(body.features) ? body.features : [];
  const duration = String(body.duration || 'forever').trim().toLowerCase();
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (action !== 'lock' && action !== 'unlock') {
    return err(res, 400, 'hanh_dong_khong_hop_le', 'Hành động phải là lock hoặc unlock.');
  }
  const features = [];
  for (const f of featuresRaw) {
    const s = String(f || '').trim().toLowerCase();
    if (LOCKABLE_FEATURES.indexOf(s) >= 0 && features.indexOf(s) < 0) features.push(s);
  }
  if (features.length === 0) {
    return err(res, 400, 'thieu_tinh_nang', 'Chọn ít nhất 1 tính năng để khóa/mở khóa.');
  }
  if (action === 'lock') {
    if (!reason) return err(res, 400, 'thieu_ly_do', 'Khóa tính năng cần nhập lý do.');
    if (LOCK_DURATIONS[duration] === undefined) {
      return err(res, 400, 'thoi_han_khong_hop_le', 'Thời hạn phải là forever, 1d, 7d hoặc 30d.');
    }
  }
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const now = Date.now();
  if (!u.feature_locks || typeof u.feature_locks !== 'object') u.feature_locks = {};
  const before = activeLocks(u);
  const labels = features.map(featureLabel);
  if (action === 'lock') {
    const expiresAt = LOCK_DURATIONS[duration] === 0 ? 0 : now + LOCK_DURATIONS[duration];
    for (const f of features) {
      u.feature_locks[f] = { reason: reason, expires_at: expiresAt, by: 'admin', at: now };
    }
    store.saveUsers(users);
    store.appendAdminLog({
      action: 'violation_lock', user_id: userId,
      target: (u.character && u.character.name) || userId,
      detail: 'Khóa tính năng: ' + labels.join(', ') + ' — ' + LOCK_DURATION_LABELS[duration],
      before: before, after: activeLocks(u), reason: reason,
    });
  } else {
    for (const f of features) delete u.feature_locks[f];
    store.saveUsers(users);
    store.appendAdminLog({
      action: 'violation_unlock', user_id: userId,
      target: (u.character && u.character.name) || userId,
      detail: 'Mở khóa sớm tính năng: ' + labels.join(', '),
      before: before, after: activeLocks(u), reason: reason || undefined,
    });
  }
  return json(res, 200, { ok: true, action: action, user: adminUserSummary(u) });
}

// POST /auth/admin/user/violation-deduct {user_id, amount, reason}
// Trừ điểm do vi phạm: số điểm > 0, số dư không xuống dưới 0, ghi sổ cái
// với lý do. Lý do bắt buộc.
function doAdminViolationDeduct(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const amount = Math.floor(Number(body.amount));
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) return err(res, 400, 'thieu_ly_do', 'Trừ điểm do vi phạm cần nhập lý do.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    return err(res, 400, 'so_diem_khong_hop_le', 'Số điểm trừ phải từ 1 đến 100000.');
  }
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  const before = u.balance || 0;
  if (before < amount) {
    return err(res, 400, 'xu_khong_du', 'Tài khoản chỉ còn ' + before + ' điểm, không trừ được ' + amount + ' điểm.');
  }
  const after = store.addBalance(userId, -amount, 'tieu', '[Vi phạm] Trừ ' + amount + ' điểm: ' + reason);
  if (after === null) {
    return err(res, 400, 'xu_khong_du', 'Không trừ được điểm (số dư không đủ).');
  }
  store.appendAdminLog({
    action: 'violation_deduct', user_id: userId,
    target: (u.character && u.character.name) || userId,
    detail: 'Trừ điểm do vi phạm: -' + amount + ' điểm',
    before: { balance: before }, after: { balance: after }, reason: reason,
  });
  const users2 = store.loadUsers();
  return json(res, 200, { ok: true, deducted: amount, balance: after, user: adminUserSummary(users2[userId]) });
}

// POST /auth/admin/user/delete-partner {user_id}
// Xoá tài khoản ĐỐI TÁC (tạm, dùng xong thì xoá). CHỈ đối tác mới xoá được —
// tài khoản thường vẫn giữ nguyên tắc không xoá vĩnh viễn.
// Xoá: hồ sơ + số dư + lịch sử sổ cái + phiên đăng nhập + token đặt lại MK
// của tài khoản đó. Nhật ký admin GIỮ LẠI (là bằng chứng kiểm toán), và ghi
// thêm 1 dòng 'partner_delete' ghi rõ đã xoá đối tác nào, lúc nào.
function doAdminDeletePartner(req, res, body) {
  if (!adminGuard(req, res)) return;
  const userId = String(body.user_id || '');
  const users = store.loadUsers();
  const u = users[userId];
  if (!u) return err(res, 404, 'khong_tim_thay', 'Không tìm thấy tài khoản.');
  if (!u.partner) {
    return err(res, 400, 'chi_xoa_duoc_doi_tac', 'Chỉ tài khoản đối tác mới được xoá. Tài khoản thường không xoá vĩnh viễn.');
  }
  const targetName = (u.character && u.character.name) || userId;
  const targetContact = u.email || u.phone || '';
  const hadBalance = u.balance || 0;
  delete users[userId];
  store.saveUsers(users);
  // Xoá phiên đăng nhập của tài khoản này.
  const sessions = store.loadSessions();
  let sessRemoved = 0;
  for (const k of Object.keys(sessions)) {
    if (sessions[k] && sessions[k].user_id === userId) { delete sessions[k]; sessRemoved++; }
  }
  if (sessRemoved > 0) store.saveSessions(sessions);
  // Xoá token đặt lại mật khẩu của tài khoản này.
  const resets = store.loadResets();
  let resetsRemoved = 0;
  for (const k of Object.keys(resets)) {
    if (resets[k] && resets[k].user_id === userId) { delete resets[k]; resetsRemoved++; }
  }
  if (resetsRemoved > 0) store.saveResets(resets);
  // Xoá lịch sử sổ cái của tài khoản này.
  const ledger = store.loadLedger();
  const kept = Array.isArray(ledger) ? ledger.filter((e) => !e || e.user_id !== userId) : [];
  const ledgerRemoved = (Array.isArray(ledger) ? ledger.length : 0) - kept.length;
  if (ledgerRemoved > 0) store.writeJson(store.DATA_DIR + '/ledger.db', kept);
  store.appendAdminLog({
    action: 'partner_delete', user_id: userId, target: targetName,
    detail: 'Xoá tài khoản đối tác ' + targetName + (targetContact ? ' (' + targetContact + ')' : '') +
      ' — đã xoá hồ sơ + số dư ' + hadBalance + ' điểm + ' + ledgerRemoved + ' dòng sổ cái + ' + sessRemoved + ' phiên đăng nhập',
    before: { partner: true, balance: hadBalance }, after: { deleted: true },
  });
  return json(res, 200, { ok: true, deleted: true, target: targetName, ledger_removed: ledgerRemoved });
}

// GET /auth/admin/log?limit=&action= — nhật ký thao tác admin (mới nhất trước).
function doAdminLog(req, res) {
  if (!adminGuard(req, res)) return;
  let q = {};
  try { q = new URL(req.url, 'http://localhost').searchParams; } catch (e) {}
  const limit = Math.max(1, Math.min(200, parseInt(q.get('limit') || '100', 10) || 100));
  const action = (q.get('action') || '').trim();
  let log = store.loadAdminLog();
  if (action) log = log.filter((e) => e && e.action === action);
  return json(res, 200, { ok: true, total: log.length, log: log.slice(-limit).reverse() });
}
