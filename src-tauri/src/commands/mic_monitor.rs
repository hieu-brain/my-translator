//! Phát hiện "có cuộc gọi": một app khác đang dùng micro.
//!
//! Teams, Meet, Zoom, FaceTime đều mở thiết bị thu khi vào phòng. CoreAudio
//! cho đọc cờ `kAudioDevicePropertyDeviceIsRunningSomewhere` của thiết bị thu
//! mặc định mà không cần quyền micro — đây cũng là tín hiệu đứng sau chấm cam
//! trên thanh menu. Không biết được app NÀO đang dùng, nên phía JS chỉ hỏi,
//! không tự ghi.
//!
//! Thăm dò mỗi 1,5 s thay vì đăng ký listener: một lần đọc thuộc tính là rẻ,
//! và khi người dùng đổi micro mặc định giữa chừng thì vòng lặp tự theo thiết
//! bị mới mà không phải quản lý listener trên từng thiết bị.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
pub struct MicActivity {
    pub active: bool,
}

#[derive(Serialize, Clone)]
pub struct LaunchInfo {
    /// true khi hệ thống tự mở app lúc đăng nhập (plugin autostart truyền
    /// `--autostart`). JS dùng để KHÔNG hiện cửa sổ, chỉ chờ cuộc gọi.
    pub autostart: bool,
}

#[tauri::command]
pub fn get_launch_info() -> LaunchInfo {
    LaunchInfo {
        autostart: std::env::args().any(|a| a == "--autostart"),
    }
}

/// Chạy vòng thăm dò trong thread riêng; bắn event `mic-activity` mỗi khi cờ
/// đổi trạng thái. Lần đọc đầu không bắn (tránh hỏi ngay lúc mở app).
pub fn start(app: AppHandle) {
    let stop = Arc::new(AtomicBool::new(false));
    std::thread::Builder::new()
        .name("mic-monitor".into())
        .spawn(move || {
            let mut last: Option<bool> = None;
            while !stop.load(Ordering::Relaxed) {
                if let Some(active) = default_input_is_running() {
                    if last.is_some() && last != Some(active) {
                        let _ = app.emit("mic-activity", MicActivity { active });
                    }
                    last = Some(active);
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
            }
        })
        .expect("spawn mic-monitor");
}

#[cfg(target_os = "macos")]
fn default_input_is_running() -> Option<bool> {
    use coreaudio_sys::{
        kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioDeviceID, AudioObjectGetPropertyData, AudioObjectPropertyAddress, UInt32,
    };

    unsafe {
        let addr = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut device: AudioDeviceID = 0;
        let mut size = std::mem::size_of::<AudioDeviceID>() as UInt32;
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut device as *mut _ as *mut _,
        );
        if status != 0 || device == 0 {
            return None;
        }

        let addr = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut running: UInt32 = 0;
        let mut size = std::mem::size_of::<UInt32>() as UInt32;
        let status = AudioObjectGetPropertyData(
            device,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut running as *mut _ as *mut _,
        );
        if status != 0 {
            return None;
        }
        Some(running != 0)
    }
}

#[cfg(not(target_os = "macos"))]
fn default_input_is_running() -> Option<bool> {
    None
}
