//! WebSocket server nhận caption từ Chrome extension (Teams web).
//!
//! Vì sao cần: extension đọc được caption nhưng không gọi được `claude` CLI —
//! Chrome không spawn process. App thì gọi được, nên gói Max dùng miễn phí cho
//! phần tổng hợp cuộn / gợi ý trả lời / meeting note. Caption đi một chiều
//! extension → app; phần dịch realtime vẫn do extension lo (xem
//! `extension/teams-captions/README.md`).
//!
//! Bảo mật: chỉ bind 127.0.0.1, bắt buộc `?token=` khớp và `Origin` phải là
//! `chrome-extension://`. Bất kỳ trang web nào cũng connect được vào localhost,
//! nên hai lớp này là tối thiểu chứ không thừa.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

use futures_util::StreamExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message;

pub struct CaptionBridgeState {
    pub running: Mutex<Option<BridgeHandle>>,
}

pub struct BridgeHandle {
    /// `watch` chứ không phải `oneshot`: tín hiệu dừng phải đọc được ở CẢ vòng
    /// accept lẫn vòng đọc WebSocket. Trước đây chỉ vòng accept kiểm tra, nên
    /// khi extension đang nối vào thì luồng nằm mãi trong handle_client và
    /// listener không bao giờ được thả → reload app xong bị "đụng cổng".
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl BridgeHandle {
    fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Sự kiện đẩy lên frontend.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeEvent {
    Listening {
        port: u16,
    },
    Connected {
        meeting: String,
    },
    Disconnected,
    Caption {
        id: u64,
        at: String,
        name: String,
        mri: String,
        ja: String,
        vi: Option<String>,
    },
    Provisional {
        name: String,
        text: String,
    },
    Error {
        message: String,
    },
}

/// Bản tin extension gửi lên.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundMessage {
    Hello {
        #[serde(default)]
        meeting: String,
    },
    Caption {
        id: u64,
        #[serde(default)]
        at: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        mri: String,
        ja: String,
        #[serde(default)]
        vi: Option<String>,
    },
    Provisional {
        #[serde(default)]
        name: String,
        text: String,
    },
    Bye,
}

#[tauri::command]
pub fn start_caption_bridge(
    port: u16,
    token: String,
    channel: Channel<BridgeEvent>,
    state: State<'_, CaptionBridgeState>,
) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("Caption bridge cần token — tạo trong Settings".into());
    }
    stop_bridge_inner(&state);

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                let _ = ready_tx.send(Err(format!("Không tạo được runtime: {e}")));
                return;
            }
        };
        rt.block_on(serve(port, token, channel, shutdown_rx, ready_tx));
    });

    // Chờ kết quả bind để lỗi "port đang bận" báo ngay cho người dùng, thay vì
    // im lặng rồi không bao giờ nhận được caption.
    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Caption bridge không phản hồi khi khởi động".into()),
    }

    let mut guard = state.running.lock().map_err(|e| e.to_string())?;
    *guard = Some(BridgeHandle {
        shutdown: shutdown_tx,
    });
    Ok(())
}

#[tauri::command]
pub fn stop_caption_bridge(state: State<'_, CaptionBridgeState>) -> Result<(), String> {
    stop_bridge_inner(&state);
    Ok(())
}

fn stop_bridge_inner(state: &State<'_, CaptionBridgeState>) {
    if let Ok(mut guard) = state.running.lock() {
        if let Some(handle) = guard.as_ref() {
            handle.stop();
        }
        *guard = None;
    }
}

async fn serve(
    port: u16,
    token: String,
    channel: Channel<BridgeEvent>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let listener = match bind_with_retry(port).await {
        Ok(l) => l,
        Err(e) => {
            let _ = ready.send(Err(format!(
                "Không mở được cổng {port}: {e} — đổi cổng trong Settings"
            )));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let _ = channel.send(BridgeEvent::Listening { port });

    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => break,
            res = listener.accept() => res,
        };
        if *shutdown.borrow() {
            break;
        }

        let stream = match accepted {
            Ok((s, _)) => s,
            Err(e) => {
                let _ = channel.send(BridgeEvent::Error {
                    message: format!("Lỗi accept: {e}"),
                });
                continue;
            }
        };

        // Một client tại một thời điểm là đủ (một cuộc họp). Xử lý tuần tự để
        // không phải chia sẻ Channel qua nhiều task.
        handle_client(stream, &token, &channel, &mut shutdown).await;
        if *shutdown.borrow() {
            break;
        }
    }
    // listener drop ở đây → cổng được thả ngay, kể cả khi client vẫn đang nối.
}

/// Bind có thử lại: sau khi dừng, cổng có thể mất một nhịp mới được hệ điều
/// hành thả ra. Thử lại vài lần thay vì bắt người dùng bấm Start hai lần.
async fn bind_with_retry(port: u16) -> Result<TcpListener, std::io::Error> {
    let mut last = None;
    for attempt in 0..10 {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(100 * (attempt + 1))).await;
            }
        }
    }
    Err(last.expect("vòng lặp chạy ít nhất một lần"))
}

async fn handle_client(
    stream: tokio::net::TcpStream,
    token: &str,
    channel: &Channel<BridgeEvent>,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) {
    let expected = token.to_string();
    let ws = tokio_tungstenite::accept_hdr_async(stream, move |req: &Request, res: Response| {
        check_handshake(req, &expected)?;
        Ok(res)
    })
    .await;

    let mut ws = match ws {
        Ok(ws) => ws,
        Err(e) => {
            let _ = channel.send(BridgeEvent::Error {
                message: format!("Từ chối kết nối: {e}"),
            });
            return;
        }
    };

    loop {
        // Đọc tin nhắn NHƯNG vẫn nghe tín hiệu dừng — nếu không, một client nối
        // mãi sẽ giữ cổng cho tới khi thoát hẳn app.
        let msg = tokio::select! {
            _ = shutdown.changed() => break,
            m = ws.next() => match m {
                Some(m) => m,
                None => break,
            },
        };

        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(_) => break,
        };

        match serde_json::from_str::<InboundMessage>(&text) {
            Ok(InboundMessage::Hello { meeting }) => {
                let _ = channel.send(BridgeEvent::Connected { meeting });
            }
            Ok(InboundMessage::Caption {
                id,
                at,
                name,
                mri,
                ja,
                vi,
            }) => {
                let _ = channel.send(BridgeEvent::Caption {
                    id,
                    at,
                    name,
                    mri,
                    ja,
                    vi,
                });
            }
            Ok(InboundMessage::Provisional { name, text }) => {
                let _ = channel.send(BridgeEvent::Provisional { name, text });
            }
            Ok(InboundMessage::Bye) => break,
            Err(e) => {
                let _ = channel.send(BridgeEvent::Error {
                    message: format!("Bản tin không hợp lệ: {e}"),
                });
            }
        }
    }

    let _ = channel.send(BridgeEvent::Disconnected);
}

/// Chặn mọi thứ không phải extension của chúng ta: token phải khớp và Origin
/// phải là `chrome-extension://`. Không có hai lớp này thì bất kỳ trang web nào
/// đang mở cũng bơm được caption giả vào app.
fn check_handshake(req: &Request, expected: &str) -> Result<(), ErrorResponse> {
    let deny = |msg: &str| -> ErrorResponse {
        http::Response::builder()
            .status(http::StatusCode::FORBIDDEN)
            .body(Some(msg.to_string()))
            .expect("static response")
    };

    let origin_ok = req
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|o| o.starts_with("chrome-extension://"))
        .unwrap_or(false);
    if !origin_ok {
        return Err(deny("origin không được phép"));
    }

    let token_ok = req
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .any(|(k, v)| k == "token" && v == expected);
    if !token_ok {
        return Err(deny("token sai"));
    }

    Ok(())
}
