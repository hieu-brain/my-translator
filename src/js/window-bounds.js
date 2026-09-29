/**
 * Kẹp vị trí cửa sổ vào các màn hình đang thật sự kết nối.
 *
 * Vì sao cần: vị trí cửa sổ được lưu lại giữa các phiên. Nếu phiên trước cửa
 * sổ nằm trên màn hình ngoài, rút màn hình đó ra rồi mở app lại thì vị trí đã
 * lưu trỏ ra ngoài vùng nhìn thấy — app chạy bình thường nhưng "không lên".
 * Ngưỡng cứng kiểu `x > 5000` không bắt được ca này: x=1458 vẫn là số hợp lý,
 * chỉ là màn hình còn lại chỉ rộng 1440.
 *
 * Tách riêng khỏi app.js để kiểm thử được mà không phải dựng cả ứng dụng.
 */

/** Số pixel logic tối thiểu phải nhìn thấy theo mỗi chiều thì mới coi là hợp lệ. */
export const MIN_VISIBLE = 120;

/**
 * Monitor của Tauri trả về pixel VẬT LÝ — quy về toạ độ logic để so sánh với
 * vị trí cửa sổ (cũng là toạ độ logic).
 */
export function normalizeMonitors(monitors) {
    return (monitors || [])
        .filter((m) => m?.position && m?.size)
        .map((m) => {
            const f = m.scaleFactor || 1;
            return {
                x: m.position.x / f,
                y: m.position.y / f,
                w: m.size.width / f,
                h: m.size.height / f,
            };
        });
}

/**
 * @returns {{x:number,y:number}|null} vị trí nhìn thấy được, hoặc null nếu
 *   không biết màn hình nào (khi đó nên bỏ vị trí đã lưu và để cửa sổ căn giữa).
 */
export function clampToVisibleScreen(screens, x, y, w, h) {
    if (!screens?.length) return null;

    // Thò ra mép một chút thường là cố ý — chỉ can thiệp khi gần như không
    // còn thấy gì.
    const visibleOn = (s) =>
        Math.min(x + w, s.x + s.w) - Math.max(x, s.x) >= MIN_VISIBLE &&
        Math.min(y + h, s.y + s.h) - Math.max(y, s.y) >= MIN_VISIBLE;
    if (screens.some(visibleOn)) return { x, y };

    // Kéo về màn hình gần nhất theo trục X. Math.max đặt sau Math.min để cửa
    // sổ to hơn màn hình vẫn bám mép trái thay vì trôi ra ngoài.
    const near = screens.reduce((best, cur) =>
        Math.abs(cur.x - x) < Math.abs(best.x - x) ? cur : best);
    return {
        x: Math.round(Math.max(near.x, Math.min(x, near.x + near.w - w))),
        y: Math.round(Math.max(near.y, Math.min(y, near.y + near.h - h))),
    };
}
