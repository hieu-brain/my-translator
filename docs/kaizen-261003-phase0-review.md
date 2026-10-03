# Kaizen 2026-10-03 — đánh giá kế hoạch và kết quả Giai đoạn 0

Kế hoạch được đánh giá: `docs/prompt-improvement-260920-personalized-meeting-assistant.md`
(viết ở session khác, dựa trên `docs/quality-review-260918-nod-weekly-meeting.md`).

## 1. Kết quả Giai đoạn 0

### 0.1 Đường thu `both` — giả định của kế hoạch ĐÚNG, đã sửa

`start_capture("both")` cũ đẩy nguyên từng khối PCM của system rồi của mic vào
chung một kênh. Mỗi nguồn tự phát khoảng 200 ms một khối, nên Soniox nhận
1 giây thật thành 2 giây xen kẽ: 200 ms cuộc họp, 200 ms mic, lại cuộc họp…
Câu nào cũng bị băm bởi nguồn kia. Đây là lý do tiếng của chính Hieu gần như
không nhận được (độ phủ 12%, xem mục 0.3) chứ không phải tại micro.

Sửa: `src-tauri/src/audio/mixer.rs` cộng mẫu có bão hoà, đệm hai nguồn và ghép
theo độ dài; nguồn nào im quá 300 ms thì nguồn kia được xả một mình để không
treo. 7 unit test (`cargo test mixer`), trong đó có test "1 giây vào = 1 giây
ra" — chính là lỗi cũ. **Chưa nghe thử trên máy thật**; buổi họp tới chạy
`both` rồi đo lại là phép thử thật.

### 0.2 Cấu hình NOD — giả định "0 dòng code" SAI, đã sửa 2 lỗi

Kế hoạch (và bản đánh giá 18/09) cho rằng chỉ cần dán terms vào Cài đặt. Dò
đường dữ liệu đến cuối thì không phải vậy:

| Chặng | Trạng thái trước | Hậu quả |
|---|---|---|
| Form → `custom_context` JS | có đủ `general`, `terms`, `text`, `translation_terms` | — |
| JS → `settings.json` (Rust `CustomContext`) | chỉ có `domain` + `translation_terms` | serde rơi 3 field: Transcription terms gõ vào mất ngay sau khi lưu |
| `settings.json` → config Soniox (`soniox.js`) | `general` chỉ nhận dạng mảng, form lưu dạng map | General context bị bỏ qua kể cả khi lưu được |

Cả hai đã sửa (`settings.rs`, `soniox.js`), có test round-trip
(`cargo test settings::tests`). Nếu triển khai Bước 0 của bản đánh giá trên
bản 0.10.4 thì sẽ không thấy tiến bộ và kết luận sai là "terms không giúp".

File dán vào Cài đặt: `docs/profiles/nod-profile.md` + `docs/profiles/nod/*`
(ngoài git vì có tên và email).

### 0.3 Script đo — xong, có mốc

`benchmarks/compare-with-teams-transcript.mjs`, chạy trên cặp 18/09:

| # | Chỉ số | Kế hoạch kỳ vọng | Đo được | Ghi chú |
|---|---|---|---|---|
| 1 | Độ phủ dòng Teams có nội dung | ~85% | **78%** (702/898) | chỉ tính dòng ≥ 6 ký tự, không đệm. Hieu: **12%**; người khác 62–86% |
| 2 | Tên riêng/thuật ngữ nghe đúng | ~50% | **40%** (100/247) | tính trên dòng đã ghép có term. Tên người 25–35%, LAT 63% |
| 3 | Nhãn người nói | ~0 | **49% thuần** | 4 nhãn cho 7 người; nền "đoán toàn Sakata" đã là 43% → gần ngẫu nhiên |
| 4 | Segment đệm | ~18% | **20%** (508/2493) | chiếm chỗ trong context gửi LLM |
| 5 | Action có người thật / ticket / cả hai | 0 | **8 / 6 / 3** trên 31 | 20 action gán cho "Speaker N" |

Phép ghép đã kiểm tra bằng mắt (`--show-pairs`): lệch đồng hồ 1–5 s, cặp
đúng câu. Chênh với kỳ vọng là do định nghĩa chặt hơn, không phải dữ liệu khác.

## 2. Đánh giá kế hoạch

### Đúng
- Xuất phát từ số đo thật, có bảng điểm, có nguyên tắc rõ (không bịa, mọi
  quyết định có trích JA + mốc giờ, không thêm dịch vụ ngoài, dừng sau mỗi
  giai đoạn).
- Giai đoạn 0 "kiểm tra giả định trước khi viết tính năng" đặt đúng chỗ, và
  0.1 đoán trúng một bug thật.

### Chưa ổn
1. **0.2 kết luận "không cần code" từ việc nhìn UI**, chưa dò đường dữ liệu
   đến đích. Với app này mọi ô cài đặt đi qua 3 chặng (form → Rust struct →
   config message); CLAUDE.md đã ghi gotcha này từ trước. Bài học cho prompt
   lần sau: *"với mỗi mục 0 dòng code, chỉ ra file:dòng ở cả ba chặng"*.
2. **Giai đoạn 1 (hybrid Soniox + Teams captions để lấy tên) đi ngược phản
   hồi đã có**: Hieu đã nói extension setup phiền, mỗi buổi phải bật caption
   và chọn đúng spoken language, và đã đóng băng hướng đó. Lợi ích duy nhất
   là tên người nói — mà tên không cần cho việc *hiểu realtime*, chỉ cần cho
   *note sau họp*. Có đường rẻ hơn: VTT của Teams đã nằm trong quy trình
   ("Hieu tải VTT tay rồi chép vào thư mục họp"), và script đo đã có sẵn bộ
   ghép dòng; thêm một chế độ *gắn tên từ VTT vào note* là nửa ngày, không
   đụng extension, không thêm bước nào trong lúc họp.
3. **Giai đoạn 2 mới là chỗ lợi nhất trên công sức** nhưng bị xếp sau: 31
   action chỉ 8 có người thật và 3 có ticket; chủ đề bị đoạn cuối ghi đè;
   20% context gửi LLM là うん/はい. Toàn bộ là prompt + lọc, không cần
   hạ tầng mới.
4. **Giai đoạn 3** (màn hình LAN, MCP, AX) ngoài phạm vi "làm cái chính thật
   ổn". Để lại.
5. Chỉ số 3 ghi "≈ 0" không đo được; đã đổi thành độ thuần nhãn để có số.

### Cách làm (viết plan ở session khác, triển khai ở session này)
Hợp lý: plan có cấu trúc, người triển khai có thể phản biện bằng số. Thiếu
một thứ: mỗi giả định trong plan cần kèm bằng chứng (file:dòng, hoặc "chưa
kiểm tra"). 0.1 có, 0.2 không, và 0.2 chính là chỗ sai.

## 3. Thứ tự đề nghị tiếp theo (chờ chốt)

1. **Buổi T3 07/10**: dùng 0.10.5, chọn *Cả hai* (⌘3), dán context theo
   `nod-profile.md`. Sau họp tải VTT, chạy script đo. Đây là phép thử thật
   cho 0.1 và 0.2; mục tiêu: độ phủ Hieu từ 12% lên trên 60%, term từ 40% lên
   trên 60%.
2. **Giai đoạn 2 trước Giai đoạn 1** (mỗi việc dưới một ngày):
   lọc đệm khỏi transcript gửi LLM; tóm tắt tích luỹ theo chủ đề thay vì
   một câu; tóm tắt cuối bằng model mạnh trên toàn bộ transcript; mục
   "Việc của Hieu"; action bắt buộc có `[hh:mm:ss]` và trích JA; xuất note
   theo `meeting-formats.md`.
3. **Thay Giai đoạn 1 bằng "gắn tên từ VTT sau họp"**, tái dùng matcher của
   script đo. Giữ nhãn Speaker N của Soniox trong lúc họp.
4. Hoãn Giai đoạn 3.
