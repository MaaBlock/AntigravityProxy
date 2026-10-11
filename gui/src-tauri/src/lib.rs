pub mod autostart;
pub mod commands;
pub mod core_process;
pub mod ipc_named_pipe;

use tauri::{
    async_runtime::spawn,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use commands::*;
use core_process::CoreProcessManager;
use ipc_named_pipe::NamedPipeClient;

#[cfg(windows)]
static INSTANCE_MUTEX: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

#[cfg(windows)]
fn wide_string(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn show_existing_window() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };

    let title = wide_string("Antigravity Proxy");
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if !window.is_null() {
        unsafe {
            ShowWindow(window, SW_SHOW);
            ShowWindow(window, SW_RESTORE);
            SetForegroundWindow(window);
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS},
        System::Threading::CreateMutexW,
    };

    let name = wide_string("Local\\AntigravityProxy.Gui.SingleInstance.v1");
    let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };

    if mutex.is_null() {
        // Do not make a transient Win32 error prevent the application from starting.
        return true;
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(mutex) };
        show_existing_window();
        return false;
    }

    // Keeping the handle open owns the named mutex for the process lifetime.
    let _ = INSTANCE_MUTEX.set(mutex as usize);
    true
}

#[cfg(not(windows))]
fn acquire_single_instance() -> bool {
    true
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !acquire_single_instance() {
        return;
    }

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle();

            // Initialize State
            let core_manager = CoreProcessManager::new(handle.clone());
            let ipc_client = NamedPipeClient::new(handle.clone());

            // Build Tray Menu
            let quit_i = MenuItem::with_id(app, "quit", "❌ 退出程序", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "🪟 显示窗口", true, None::<&str>)?;
            let start_i = MenuItem::with_id(app, "start", "▶ 启动服务", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop", "⏹ 停止服务", true, None::<&str>)?;
            let restart_i = MenuItem::with_id(app, "restart", "🔄 重启服务", true, None::<&str>)?;

            let tray_menu = Menu::with_items(app, &[&show_i, &start_i, &stop_i, &restart_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Antigravity Proxy 控制中心")
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    let manager = app.state::<CoreProcessManager>().inner().clone();
                    match id {
                        "quit" => {
                            spawn(async move {
                                let _ = manager.stop().await;
                            });
                            app.exit(0);
                        }
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "start" => {
                            spawn(async move {
                                let _ = manager.start().await;
                            });
                        }
                        "stop" => {
                            spawn(async move {
                                let _ = manager.stop().await;
                            });
                        }
                        "restart" => {
                            spawn(async move {
                                let _ = manager.restart().await;
                            });
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Auto-start core in background (non-blocking)
            let manager_init = core_manager.clone();
            spawn(async move {
                let cfg = manager_init.get_config().await;
                if cfg.auto_start_core {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                    let _ = manager_init.start().await;
                }
            });

            app.manage(ipc_client);
            app.manage(core_manager);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Minimize to tray instead of closing
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_start,
            core_stop,
            core_restart,
            core_get_status,
            core_rpc,
            get_config,
            save_config,
            set_app_autostart,
            is_app_autostart,
            open_external,
            open_path,
            minimize_window,
            maximize_window,
            close_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
