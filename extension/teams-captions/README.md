# Teams Captions Bridge

Chrome extension đọc **live captions** của Microsoft Teams bản web, dịch sang tiếng Việt
bằng Claude, và xuất transcript ra file.

Chạy độc lập được, hoặc nối với app My Translator để dùng meeting assistant qua gói Claude Max.

## Cài đặt

1. Mở `chrome://extensions`, bật **Developer mode**.
2. **Load unpacked** → chọn thư mục `extension/teams-captions`.
3. Bấm vào extension → **Cài đặt** → chọn engine dịch và dán API key.
4. Vào `teams.cloud.microsoft`, tham gia cuộc họp, bật
   **More → Language and speech → Turn on live captions**.
5. **Bấm icon extension trên thanh công cụ** để mở panel.

**Panel không tự bật lên.** Teams còn dùng cho chat và gọi lẻ, tự hiện mỗi lần load
trang là phiền. Panel đóng = không đọc caption, không chạy ngầm, không tốn gì. Muốn
quay lại kiểu cũ thì bật *Tự mở panel khi vào Teams* trong Cài đặt.

**Mặc định KHÔNG dịch.** Bấm nút `VI` trên panel khi cần — những câu đã ghi trước đó
sẽ được dịch bù. Không bật thì extension chỉ ghi tiếng Nhật, không gọi API, không tốn
tiền. Muốn bật sẵn thì tick *Bật dịch sẵn khi mở panel* trong Cài đặt.

> ⚠️ **Nhớ chọn đúng ngôn ngữ nói trong Teams.** Trong menu live captions có mục
> *Change spoken language*. Nếu để English mà mọi người nói tiếng Nhật, caption ra
> tiếng Anh vô nghĩa (đã gặp lúc test: 「橋本さん」→ `Is your Hachi got an ishii miss?`).
> Extension không sửa được lỗi này — nó chỉ đọc lại những gì Teams hiển thị.

## Nút trên panel

| Nút | Việc |
|---|---|
| `VI` | Bật/tắt dịch. Bật lại sẽ dịch bù những câu còn trống. |
| `▤` | Chế độ compact — chỉ 3 dòng cuối, đặt gần khung caption. |
| `❙❙` | Tạm dừng ghi (caption vẫn chạy, chỉ không lưu). |
| `⤓` | Xuất `.txt` / `.md` / `.json`, copy clipboard, xoá, cài đặt. |
| `—` | Thu nhỏ thành pill, **vẫn ghi**. Bấm pill để mở lại. |
| `✕` | Đóng hẳn và **ngừng ghi**. Bấm icon extension để mở lại. |

Xuất file thành công sẽ **dọn transcript luôn**, để cuộc họp sau bắt đầu từ trang trắng.
Nếu tải về bị chặn thì nội dung được copy vào clipboard và **không** dọn.

Kéo header để di chuyển, kéo góc dưới-phải để đổi kích thước. Vị trí được nhớ lại.

Transcript tự lưu vào `chrome.storage.local` mỗi 2s — reload tab giữa cuộc họp không mất dữ liệu.

## Chi phí — gom lô là đòn bẩy chính

Dịch từng câu nghĩa là system prompt (~250 token) bị gửi lại ~900 lần mỗi giờ họp.
Gom 6 câu một lần giảm số request 6 lần và chia đều system prompt.

| Cách | Chi phí / giờ họp (ước lượng) |
|---|---|
| Opus 5, từng câu | ~$2.7 |
| Haiku 4.5, từng câu | ~$0.5 |
| **Haiku 4.5 + gom lô 6 câu** (mặc định) | **~$0.2** |
| Gemini Flash free tier | $0, giới hạn ~15 request/phút |

Đánh đổi: bản dịch trễ thêm vài giây. Giảm **Số câu mỗi lô** / **Chờ tối đa** trong
Cài đặt nếu cần bám sát để phát biểu. Ô ước lượng chi phí trong Cài đặt cập nhật theo
lựa chọn của bạn.

## Nối với app My Translator (tuỳ chọn)

Extension không gọi được `claude` CLI — Chrome không spawn process. App thì gọi được,
nên phần **tổng hợp cuộn / gợi ý trả lời / meeting note** chạy bằng gói Max, không tốn
thêm tiền. Phần dịch realtime vẫn ở lại extension (CLI mất 2–5s mỗi lần gọi, quá chậm
cho caption).

1. Trong app: **Cài đặt → Engine → Teams captions**, copy cổng và token.
2. Trong extension: **Cài đặt → Cầu nối sang app** → bật, dán cổng + token, Lưu.
3. Trong app: bấm Start. App sẽ chờ extension nối vào.

Caption được gửi hai lần cho mỗi câu: lúc chốt (chưa có bản dịch, để app hiện tiếng
Nhật ngay) và lúc dịch xong (cùng id — app ghép theo khoá, không theo vị trí).

Bảo mật: app chỉ nghe ở `127.0.0.1`, bắt buộc token khớp và `Origin` phải là
`chrome-extension://`. Câu chưa gửi được sẽ gửi bù khi nối lại (tối đa 500 câu).

## Cấu trúc

```
manifest.json
background.js          service worker: điều phối dịch + cầu nối WS
options.html/.js       engine, API key, ngôn ngữ, thuật ngữ, gom lô, cầu nối
src/
  selectors.js         selector DOM của Teams — file DUY NHẤT cần sửa nếu Teams đổi layout
  stabilizer.js        biến mutation thô thành câu đã chốt + MutationObserver watcher
  store.js             transcript trong RAM + autosave
  batcher.js           gom câu thành lô — đòn bẩy chi phí
  engines.js           anthropic | gemini, structured output ở cả hai
  bridge.js            WebSocket client đẩy caption sang app
  exporter.js          txt / md / json + download
  panel.js             UI trong Shadow DOM
  content.js           nối các mảnh lại
```

## Vì sao panel riêng, không chèn tiếng Việt vào khung caption gốc

Đo thực tế: trong 15 giây có **18 lần `add` và 18 lần `del`** node. React của Teams
unmount/remount row liên tục để cuộn virtual list. Node chèn vào sẽ bị xoá sau ~1s.
Panel nằm trong Shadow DOM riêng nên React không đụng tới được. Chế độ compact bù lại
phần "cảm giác inline".

## Thuật toán chốt câu

Teams cập nhật caption theo 3 kiểu:

1. Câu đang nói được sửa **tại chỗ** qua `characterData`, cách nhau 150–400ms.
2. Câu mới xuất hiện dưới dạng `addedNode`, text đã đầy đủ.
3. **Node bị xoá KHÔNG có nghĩa là câu đã xong** — virtual list unmount rồi mount lại
   cùng một câu chỉ sau 1.2s.

Vì (3), không thể dùng "node bị remove" làm tín hiệu chốt, cũng không dùng node identity
làm khoá. Quy tắc thực tế:

- Dòng cuối = provisional, chốt khi text đứng yên 1200ms.
- Các dòng trước chốt ngay, nhưng phải thấy y hệt ở snapshot trước (ổn định 1 tick).
- Khử trùng lặp theo `mri|text` trong cửa sổ 30 câu gần nhất.

### Đã kiểm chứng trên cuộc họp thật

Chạy đúng thuật toán này trên trang Teams đang họp, ~85 câu:

- Bắt được toàn bộ lịch sử đang hiển thị ngay khi gắn observer (t=63ms).
- **0 câu trùng lặp** trong cửa sổ khử lặp.
- Provisional cập nhật mượt (60 lần / 25s).
- Câu ngắn lặp lại cách nhau xa (`仲村 良太: Hi.` ở t=63ms và t=53.7s) vẫn được ghi cả hai lần.

**Giới hạn đã biết:** câu ngắn giống hệt, cùng người nói, lặp lại trong vòng 30 dòng sẽ bị
bỏ một lần (thường là 「はい。」). Đổi `dedupeWindow` trong `stabilizer.js` nếu muốn khác.

## Ghi chú về API key

Key lưu trong `chrome.storage.local` (không đồng bộ lên tài khoản Google) và chỉ được
đọc trong service worker — trang web không truy cập được.
