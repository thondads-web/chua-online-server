// ============================================================
// mailer.js — Gửi email đặt lại mật khẩu.
// DỊCH VỤ CHÍNH: Brevo (REST API https://api.brevo.com/v3/smtp/email,
//   free 300 email/ngày, không cần thẻ tín dụng, gọi qua HTTPS nên
//   không bị chặn cổng SMTP như các host free).
//   Cấu hình: biến môi trường BREVO_API_KEY (lấy tại Brevo dashboard
//   Settings → SMTP & API → API Keys).
// DỰ PHÒNG 1: Resend (RESEND_API_KEY) — giữ lại để tương thích; chỉ dùng
//   khi không có BREVO_API_KEY. (Đăng ký Resend thất bại 3 lần 06/11
//   do lỗi hệ thống phía Resend nên Brevo là chính.)
// DỰ PHÒNG 2: Gmail SMTP trực tiếp (GMAIL_APP_PASSWORD) — thêm 07/11 vì
//   Brevo bắt xác minh SĐT bằng SMS nhưng SMS Brevo KHÔNG BAO GIỜ về số
//   0329983699 (4 lần gửi 07/11: 00:50, 00:53, 12:15, 19:10, Brevo đều
//   báo "đã gửi" nhưng máy không nhận được mã nào) nên không lấy được
//   API key Brevo. Gmail SMTP dùng chính Gmail thondads@gmail.com gửi,
//   không cần Brevo, không cần SMS Brevo. Cần bật xác minh 2 bước Gmail
//   rồi tạo Mật khẩu ứng dụng 16 ký tự (myaccount.google.com → Bảo mật
//   → Mật khẩu ứng dụng). Giới hạn Gmail ~500 email/ngày — thừa cho
//   email đặt lại mật khẩu. Dùng module tls có sẵn của Node, KHÔNG thêm
//   thư viện ngoài (Bonto chưa chắc chạy npm install khi pull).
//   Cấu hình: GMAIL_USER (mặc định thondads@gmail.com) + GMAIL_APP_PASSWORD.
// Chưa có key nào → chế độ dev: chỉ log ra server log, KHÔNG gửi.
// NGƯỜI GỬI: biến MAIL_FROM, vd 'Phật Pháp Online <thondads@gmail.com>'.
//   Địa chỉ email này PHẢI được xác minh trong Brevo (Settings →
//   Senders & IP) thì Brevo mới cho gửi. Mặc định: thondads@gmail.com.
//   Với Gmail SMTP, địa chỉ envelope (MAIL FROM) luôn là GMAIL_USER để
//   Gmail chấp nhận; header From vẫn hiển thị tên như MAIL_FROM.
// TUYỆT ĐỐI không trả token/link reset về cho client qua bất kỳ đường nào.
// TUYỆT ĐỐI không log mật khẩu ứng dụng hay nội dung email.
// ============================================================
'use strict';

const tls = require('tls');

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const RESEND_API = 'https://api.resend.com/emails';
const GMAIL_SMTP_HOST = 'smtp.gmail.com';
const GMAIL_SMTP_PORT = 465;

function mailConfigured() {
  return !!(
    process.env.BREVO_API_KEY ||
    process.env.RESEND_API_KEY ||
    process.env.GMAIL_APP_PASSWORD
  );
}

// Tách 'Tên <email>' thành { name, email }; nếu chỉ có email thì name rỗng.
function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*)<([^<>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^["']|["']$/g, ''), email: m[2].trim() };
  return { name: '', email: s };
}

function resetHtml(resetLink) {
  return (
    '<p>A Di Đà Phật,</p>' +
    '<p>Thí chủ vừa yêu cầu đặt lại mật khẩu. Bấm link sau (hết hạn sau 60 phút):</p>' +
    '<p><a href="' + resetLink + '">Đặt lại mật khẩu</a></p>' +
    '<p>Nếu thí chủ không yêu cầu, xin bỏ qua email này.</p>' +
    '<p>Nam Mô A Di Đà Phật 🙏<br/>Phật Pháp Online</p>'
  );
}

async function sendViaBrevo(toEmail, resetLink, from) {
  try {
    const r = await fetch(BREVO_API, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: from.name || 'Phật Pháp Online', email: from.email },
        to: [{ email: toEmail }],
        subject: 'Đặt lại mật khẩu — Phật Pháp Online',
        htmlContent: resetHtml(resetLink),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.log('[mailer] Brevo lỗi ' + r.status + ': ' + t.slice(0, 200));
      return { sent: false, error: 'brevo_' + r.status };
    }
    return { sent: true };
  } catch (e) {
    console.log('[mailer] Lỗi gửi email: ' + (e && e.message));
    return { sent: false, error: 'network' };
  }
}

async function sendViaResend(toEmail, resetLink, fromRaw) {
  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromRaw,
        to: [toEmail],
        subject: 'Đặt lại mật khẩu — Phật Pháp Online',
        html: resetHtml(resetLink),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.log('[mailer] Resend lỗi ' + r.status + ': ' + t.slice(0, 200));
      return { sent: false, error: 'resend_' + r.status };
    }
    return { sent: true };
  } catch (e) {
    console.log('[mailer] Lỗi gửi email: ' + (e && e.message));
    return { sent: false, error: 'network' };
  }
}

// --- Gmail SMTP trực tiếp (dự phòng 2) -------------------------------------
// Client SMTP tối giản trên TLS có sẵn của Node, cổng 465 (implicit TLS).
// Không dùng thư viện ngoài để tránh phụ thuộc npm install trên Bonto.

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

// Mã hoá từ/cụm có dấu tiếng Việt trong header theo RFC 2047.
function encodeWord(s) {
  if (/[^\x00-\x7F]/.test(s)) return '=?UTF-8?B?' + b64(s) + '?=';
  return s;
}

function sendViaGmail(toEmail, resetLink, from) {
  const user = (process.env.GMAIL_USER || 'thondads@gmail.com').trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!pass) return Promise.resolve({ sent: false, error: 'gmail_no_password' });

  const displayName = encodeWord(from.name || 'Phật Pháp Online');
  const headers = [
    'From: ' + displayName + ' <' + from.email + '>',
    'To: <' + toEmail + '>',
    'Subject: ' + encodeWord('Đặt lại mật khẩu — Phật Pháp Online'),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(resetHtml(resetLink), 'utf8').toString('base64'),
    '',
  ].join('\r\n');

  return new Promise((resolve) => {
    let done = false;
    let socket = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { if (socket) socket.destroy(); } catch (e) { /* bỏ qua */ }
      resolve(r);
    };

    socket = tls.connect(GMAIL_SMTP_PORT, GMAIL_SMTP_HOST, {
      servername: GMAIL_SMTP_HOST,
    });
    socket.setTimeout(20000, () => finish({ sent: false, error: 'gmail_timeout' }));
    socket.on('error', (e) => {
      console.log('[mailer] Gmail SMTP lỗi kết nối: ' + (e && e.message));
      finish({ sent: false, error: 'gmail_network' });
    });

    let buf = '';
    let step = 0; // 0 chào 220 → 1 EHLO → 2 AUTH LOGIN → 3 user → 4 pass
                  // → 5 MAIL FROM → 6 RCPT TO → 7 DATA → 8 gửi nội dung → 9 QUIT
    const send = (line) => {
      try { socket.write(line + '\r\n'); }
      catch (e) { finish({ sent: false, error: 'gmail_network' }); }
    };

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = line.match(/^(\d{3})([ -])(.*)$/);
        if (!m) continue;
        if (m[2] === '-') continue; // dòng tiếp nối multi-line, đợi dòng cuối
        const code = m[1];
        if (code[0] !== '2' && code !== '334' && code !== '354') {
          console.log('[mailer] Gmail SMTP lỗi ' + code + ': ' + line.slice(0, 120));
          send('QUIT');
          return finish({ sent: false, error: code === '535' ? 'gmail_auth' : 'gmail_' + code });
        }
        if (step === 0) { step = 1; send('EHLO phatphaponline.pages.dev'); }
        else if (step === 1) { step = 2; send('AUTH LOGIN'); }
        else if (step === 2) { step = 3; send(b64(user)); }
        else if (step === 3) { step = 4; send(b64(pass)); }
        else if (step === 4) { step = 5; send('MAIL FROM:<' + user + '>'); }
        else if (step === 5) { step = 6; send('RCPT TO:<' + toEmail + '>'); }
        else if (step === 6) { step = 7; send('DATA'); }
        else if (step === 7) { step = 8; send(headers + '.'); }
        else if (step === 8) { step = 9; console.log('[mailer] Gmail SMTP đã gửi tới ' + toEmail); send('QUIT'); return finish({ sent: true }); }
      }
    });
  });
}

// Gửi email đặt lại mật khẩu. Trả về { sent: true } hoặc { sent: false, dev: true }.
// `resetLink` chỉ được log ở chế độ dev — không bao giờ đưa vào response HTTP.
async function sendResetEmail(toEmail, resetLink) {
  const fromRaw = process.env.MAIL_FROM || 'Phật Pháp Online <thondads@gmail.com>';
  const from = parseFrom(fromRaw);
  if (process.env.BREVO_API_KEY) return sendViaBrevo(toEmail, resetLink, from);
  if (process.env.RESEND_API_KEY) return sendViaResend(toEmail, resetLink, fromRaw);
  if (process.env.GMAIL_APP_PASSWORD) return sendViaGmail(toEmail, resetLink, from);
  // Chế độ dev: ghi link vào server log để dev tự test (không gửi email thật).
  console.log('[mailer:dev] Chưa cấu hình BREVO_API_KEY/RESEND_API_KEY/GMAIL_APP_PASSWORD — không gửi email thật.');
  console.log('[mailer:dev] Link đặt lại mật khẩu cho ' + toEmail + ': ' + resetLink);
  return { sent: false, dev: true };
}

module.exports = { sendResetEmail, mailConfigured };
