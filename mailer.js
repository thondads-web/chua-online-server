// ============================================================
// mailer.js — Gửi email đặt lại mật khẩu.
// DỊCH VỤ CHÍNH: Brevo (REST API https://api.brevo.com/v3/smtp/email,
//   free 300 email/ngày, không cần thẻ tín dụng, gọi qua HTTPS nên
//   không bị chặn cổng SMTP như các host free).
//   Cấu hình: biến môi trường BREVO_API_KEY (lấy tại Brevo dashboard
//   Settings → SMTP & API → API Keys).
// DỰ PHÒNG: Resend (RESEND_API_KEY) — giữ lại để tương thích; chỉ dùng
//   khi không có BREVO_API_KEY. (Đăng ký Resend thất bại 3 lần 06/11
//   do lỗi hệ thống phía Resend nên Brevo là chính.)
// Chưa có key nào → chế độ dev: chỉ log ra server log, KHÔNG gửi.
// NGƯỜI GỬI: biến MAIL_FROM, vd 'Phật Pháp Online <thondads@gmail.com>'.
//   Địa chỉ email này PHẢI được xác minh trong Brevo (Settings →
//   Senders & IP) thì Brevo mới cho gửi. Mặc định: thondads@gmail.com.
// TUYỆT ĐỐI không trả token/link reset về cho client qua bất kỳ đường nào.
// ============================================================
'use strict';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';
const RESEND_API = 'https://api.resend.com/emails';

function mailConfigured() {
  return !!(process.env.BREVO_API_KEY || process.env.RESEND_API_KEY);
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

// Gửi email đặt lại mật khẩu. Trả về { sent: true } hoặc { sent: false, dev: true }.
// `resetLink` chỉ được log ở chế độ dev — không bao giờ đưa vào response HTTP.
async function sendResetEmail(toEmail, resetLink) {
  const fromRaw = process.env.MAIL_FROM || 'Phật Pháp Online <thondads@gmail.com>';
  const from = parseFrom(fromRaw);
  if (process.env.BREVO_API_KEY) return sendViaBrevo(toEmail, resetLink, from);
  if (process.env.RESEND_API_KEY) return sendViaResend(toEmail, resetLink, fromRaw);
  // Chế độ dev: ghi link vào server log để dev tự test (không gửi email thật).
  console.log('[mailer:dev] Chưa cấu hình BREVO_API_KEY/RESEND_API_KEY — không gửi email thật.');
  console.log('[mailer:dev] Link đặt lại mật khẩu cho ' + toEmail + ': ' + resetLink);
  return { sent: false, dev: true };
}

module.exports = { sendResetEmail, mailConfigured };
