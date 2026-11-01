# Đặc tả giao thức WebSocket — Chùa Online multiplayer

Máy chủ: `server.js` (Node.js + thư viện `ws`). Mọi bản tin là JSON.

## 1. Client → Server

| t | Trường | Ý nghĩa |
|---|--------|---------|
| `hello` | `name` (string, ≤20 ký tự) | Chào sân, đăng ký tên hiển thị |
| `pos` | `x,y,z` (số), `ry` (số, radian), `a` (string: `idle`/`walk`/`bow`/`sit`/`prostrate`) | Cập nhật vị trí + trạng thái, client gửi ~12 lần/giây khi di chuyển |
| `act` | `k` (string ≤24 ký tự), `d` (object tùy ý) | Hành động một lần. Các `k` dùng trong game: `incense` (thắp hương), `bell` (thỉnh chuông), `mok` (gõ mõ), `prostrate` (đảnh lễ), `lantern` (thả hoa đăng), `wishcard` (treo thẻ ước nguyện), `beads` (lần tràng hạt), `chant` (tụng niệm), `sit`/`stand` (ngồi/đứng thiền) |
| `ping` | — | Giữ kết nối |
| `chat` | `text` (string, ≤200 ký tự) | Nhắn chat chung (quán trà đá): server lọc HTML, chống spam 1.5s/tin, lưu 30 tin gần nhất |

## 2. Server → Client

| t | Trường | Ý nghĩa |
|---|--------|---------|
| `welcome` | `id`, `players[]` (mỗi phần tử `{id,name,x,y,z,ry,anim}`), `chat[]` (20 tin nhắn gần nhất `{id,name,text,ts}`) | Chào mừng + danh sách người đang có mặt + lịch sử chat |
| `chat` | `id`, `name`, `text`, `ts` | Một người vừa nhắn chat chung — client hiển thị vào khung chat |
| `join` | `p` `{id,name,x,y,z,ry,anim}` | Có người mới vào |
| `leave` | `id` | Có người rời đi |
| `poss` | `list[]` `{id,name,x,y,z,ry,anim}` | Gói vị trí gom 10 lần/giây — client nội suy mượt giữa các gói |
| `act` | `id`, `k`, `d` | Một người chơi vừa làm hành động `k` — client tái hiện hoạt ảnh tại vị trí người đó |
| `pong` | — | Trả lời `ping` |
| `full` | — | Sân đã đủ `MAX_PLAYERS` người, client hiển thị thông báo rồi đóng kết nối |

## 4. HTTP API cho livestream (webhook nghi thức)

- `POST /ritual` — kích hoạt nghi thức từ công cụ ngoài (TikFinity, Streamer.bot, curl).
  Body JSON: `{ "k": "incense|bell|lantern|wishcard|chant|beads|mok|prostrate|drawFortune|sit",
  "user": "Tên người xem", "wish": "lời khấn (tùy)", "d": {...}, "key": "RITUAL_KEY nếu server có đặt" }`
  → server broadcast `{t:'act', id:'streamer', k, d:{...d, user}}` cho mọi client và cộng điểm công đức.
  Ví dụ:
  `curl -X POST https://SEVER-CUA-BAN/ritual -H "Content-Type: application/json" -d '{"k":"incense","user":"Thí Chủ Minh Tâm","wish":"Cầu gia đình bình an"}'`
- `GET /merit` — xem Bảng Vàng Công Đức (top 10, JSON).
- `POST /donate` — ghi nhận cúng dường. Body: `{ "name": "Tên thí chủ (≤20 ký tự)", "amount": 50000, "wish": "lời nguyện (≤200 ký tự)" }` → `{ok:true}`; chống spam 30s/IP; tự cộng điểm công đức (1.000đ = 1 điểm, tối đa 500).
- `GET /donors` — danh sách thí chủ mới nhất + tổng tiền: `{ donors: [{name, amount, wish, ts}], total, count }`.
- `POST /feedback` — gửi góp ý. Body: `{ "name": "Tên (≤20)", "text": "nội dung (≤500 ký tự)" }` → `{ok:true}`; chống spam 60s/IP.
- `GET /feedback` — đọc 20 góp ý mới nhất (JSON).
- Bảng Vàng Công Đức: server tự cộng điểm theo từng hành động
  (thắp hương +15, đảnh lễ +15, thỉnh chuông +10, hoa đăng +10, thẻ ước nguyện +10,
  tụng niệm +5, lần hạt +2, gõ mõ +2, xin xăm +10, ngồi thiền +2),
  lưu vào `data/merit.json`, broadcast `{t:'merit', board:[{name,points}]}` mỗi khi thay đổi;
  bản tin `welcome` cũng kèm `merit` hiện tại.

## 5. Quy ước client (game Chùa Online)

- Ô nhập **địa chỉ máy chủ** trong game (lưu `localStorage`, ví dụ `wss://chua-online-server.onrender.com`).
  Khi trống → chơi chế độ mô phỏng như cũ, không kết nối.
- Nút **“Chơi cùng mọi người”**: hỏi tên (mặc định `Phật tử ####`), gửi `hello`, hiện số người online.
- Người chơi khác: dùng lại avatar chú tiểu sẵn có + **bảng tên trên đầu**.
- Nhận `poss` → nội suy vị trí (lerp) cho mượt; nhận `act` → chạy hoạt ảnh tương ứng tại chỗ người đó đứng.
- Gửi `pos` tối đa 12 lần/giây, chỉ gửi khi vị trí/trạng thái thay đổi.
- Mất kết nối → tự quay về chế độ mô phỏng, hiện nút “Kết nối lại”.
- Tên hiển thị: server đã lọc ký tự điều khiển và giới hạn 20 ký tự; client cũng nên escape HTML khi vẽ tên.
