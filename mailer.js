// ============================================================
// mailer.js — Gửi email qua Resend (khi có RESEND_API_KEY).
// Chưa có key → chế độ dev: chỉ log ra server log, KHÔNG gửi.
// TUYỆT ĐỐI không trả token/link reset về cho client qua bất kỳ đường nào.
// ============================================================
'use strict';

const RESEND_API = 'https://api.resend.com/emails';

function mailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Gửi email đặt lại mật khẩu. Trả về { sent: true } hoặc { sent: false, dev: true }.
// `resetLink` chỉ được log ở chế độ dev — không bao giờ đưa vào response HTTP.
async function sendResetEmail(toEmail, resetLink) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Chế độ dev: ghi link vào server log để dev tự test (không gửi email thật).
    console.log('[mailer:dev] Chưa cấu hình RESEND_API_KEY — không gửi email thật.');
    console.log('[mailer:dev] Link đặt lại mật khẩu cho ' + toEmail + ': ' + resetLink);
    return { sent: false, dev: true };
  }
  const from = process.env.MAIL_FROM || 'Phật Pháp Online <no-reply@phatphaponline.pages.dev>';
  try {
    const r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from,
        to: [toEmail],
        subject: 'Đặt lại mật khẩu — Phật Pháp Online',
        html:
          '<p>A Di Đà Phật,</p>' +
          '<p>Thí chủ vừa yêu cầu đặt lại mật khẩu. Bấm link sau (hết hạn sau 60 phút):</p>' +
          '<p><a href="' + resetLink + '">Đặt lại mật khẩu</a></p>' +
          '<p>Nếu thí chủ không yêu cầu, xin bỏ qua email này.</p>' +
          '<p>Nam Mô A Di Đà Phật 🙏<br/>Phật Pháp Online</p>',
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

module.exports = { sendResetEmail, mailConfigured };
