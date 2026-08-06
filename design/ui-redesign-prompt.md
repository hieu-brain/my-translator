# Prompt yêu cầu Claude thiết kế lại UI — My Translator (Meeting Edition)

> Cách dùng: mở claude.ai (hoặc Claude Code), đính kèm file `current-layout.html`, rồi dán toàn bộ prompt dưới đây.

---

Tôi có một app macOS overlay (Tauri 2, frontend vanilla HTML/CSS/JS — KHÔNG framework) dùng để **dịch song ngữ realtime trong cuộc họp** (Việt ⇄ Nhật). File `current-layout.html` đính kèm là layout hiện tại (đã inline toàn bộ CSS, kèm dữ liệu hội thoại mẫu). Hãy thiết kế lại UI cho tôi.

## Bối cảnh sử dụng
- Cửa sổ overlay **always-on-top**, thường đặt cạnh cửa sổ Zoom/Meet, kích thước nhỏ (~420×620) nhưng resize được; cần cả trạng thái mở rộng full màn hình.
- Người dùng là BrSE tham gia họp Nhật–Việt: vừa nghe, vừa liếc nhanh bản dịch, thi thoảng đọc lại đoạn trước đó.
- Theme tối, glassmorphism, nền bán trong suốt (giữ `backdrop-filter` và nền rgba để thấy nội dung phía sau).

## Yêu cầu thiết kế
1. **Transcript hội thoại là trung tâm**: 2 chế độ — single (chỉ bản dịch) và dual (gốc | dịch song song). Cải thiện cách hiển thị **người nói** (Speaker 1/2 hiện tại quá mờ nhạt — cân nhắc màu riêng từng người, avatar chữ cái, hoặc chat-bubble 2 phía kiểu hội thoại), và **badge ngôn ngữ** (🇯🇵/🇻🇳).
2. Text đang nhận dạng (provisional) phải phân biệt rõ với text đã dịch xong nhưng không gây nhấp nháy khó chịu.
3. **Panel trợ lý AI (mới)**: thiết kế thêm một panel/drawer có thể thu gọn, chứa: (a) tóm tắt cuộc họp cập nhật realtime (chủ đề, quyết định, action items), (b) nút "Tóm tắt ngay", (c) khu vực "Gợi ý trả lời" hiện 2-3 câu trả lời gợi ý (VI + JA) khi người dùng chọn một câu trong transcript. Transcript cần hỗ trợ **click chọn một câu** (trạng thái highlight).
4. Thanh công cụ gọn hơn: Start/Stop, Pause, nguồn âm thanh, trạng thái kết nối, cặp ngôn ngữ, settings. Bỏ các nút TTS/Read (đã loại khỏi app).
5. Tab "Library" (danh sách session đã lưu) và Settings giữ cấu trúc nhưng đồng bộ ngôn ngữ thiết kế mới.
6. Font size điều chỉnh được (A−/A+), phải đẹp ở cả cỡ chữ lớn (tới 40px+) cho trường hợp trình chiếu.

## Ràng buộc kỹ thuật (quan trọng)
- Trả về **một file HTML duy nhất, CSS inline trong `<style>`**, không dùng framework, không CDN ngoài (app chạy offline trong WebView).
- **GIỮ NGUYÊN toàn bộ `id` của các element hiện có** (btn-start, transcript-content, status-text, settings-view, v.v.) — JS của app bind theo id; chỉ được thêm id/class mới cho phần trợ lý AI, không đổi tên id cũ.
- Giữ các attribute `data-tauri-drag-region` ở vùng kéo cửa sổ.
- Dùng dữ liệu mẫu hội thoại VI/JA như file gốc để demo.
- Trước khi code, hãy đề xuất 3-4 hướng thiết kế khác nhau (mô tả màu nền/màu nhấn/typography/bố cục 1 dòng mỗi hướng) để tôi chọn, rồi mới implement hướng được chọn.
