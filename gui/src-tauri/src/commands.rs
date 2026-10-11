use crate::autostart::{is_autostart_enabled, set_autostart};
use crate::core_process::{AppConfig, CoreProcessManager, ProcessStatus};
use crate::ipc_named_pipe::NamedPipeClient;
use serde_json::Value;
use tauri::{State, WebviewWindow};

#[tauri::command]
pub async fn core_start(manager: State<'_, CoreProcessManager>) -> Result<String, String> {
    manager.start().await
}

#[tauri::command]
pub async fn core_stop(manager: State<'_, CoreProcessManager>) -> Result<String, String> {
    manager.stop().await
}

#[tauri::command]
pub async fn core_restart(manager: State<'_, CoreProcessManager>) -> Result<String, String> {
    manager.restart().await
}

#[tauri::command]
pub fn core_get_status(manager: State<'_, CoreProcessManager>) -> Result<ProcessStatus, String> {
    Ok(manager.get_status())
}

#[tauri::command]
pub async fn core_rpc(
    ipc: State<'_, NamedPipeClient>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    ipc.call(&method, params).await
}

#[tauri::command]
pub async fn get_config(manager: State<'_, CoreProcessManager>) -> Result<AppConfig, String> {
    Ok(manager.get_config().await)
}

#[tauri::command]
pub async fn save_config(
    manager: State<'_, CoreProcessManager>,
    config: AppConfig,
) -> Result<AppConfig, String> {
    let autostart = config.auto_start_on_boot;
    let minimized = config.start_minimized;
    manager.save_config(config).await?;
    let _ = set_autostart(autostart, minimized);
    Ok(manager.get_config().await)
}

#[tauri::command]
pub fn set_app_autostart(enable: bool, start_minimized: bool) -> Result<(), String> {
    set_autostart(enable, start_minimized)
}

#[tauri::command]
pub fn is_app_autostart() -> Result<bool, String> {
    Ok(is_autostart_enabled())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn maximize_window(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn close_window(window: WebviewWindow) -> Result<(), String> {
    // Hide window to system tray
    window.hide().map_err(|e| e.to_string())
}
