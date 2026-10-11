use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessStatus {
    pub state: String, // "STOPPED", "STARTING", "RUNNING", "STOPPING", "ERROR"
    pub pid: Option<u32>,
    pub host: String,
    pub port: u16,
    pub core_dir: String,
    pub watch_mode: bool,
    pub uptime: u64,
    pub active_accounts_count: usize,
    pub outbound_proxy: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AppConfig {
    pub core_dir: String,
    pub core_host: String,
    pub core_port: u16,
    pub core_watch_mode: bool,
    pub outbound_proxy: String,
    pub auto_detect_outbound_proxy: bool,
    pub accounts_file: String,
    pub bun_path: String,
    pub auto_start_core: bool,
    pub auto_start_on_boot: bool,
    pub start_minimized: bool,
    pub minimize_to_tray: bool,
    pub auto_restart_on_crash: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            core_dir: "".to_string(),
            core_host: "127.0.0.1".to_string(),
            core_port: 8317,
            core_watch_mode: false,
            // Leave the first-run value empty. When auto detection is enabled,
            // start() selects a reachable local proxy instead of pinning a
            // port that may change after the proxy client is upgraded.
            outbound_proxy: "".to_string(),
            auto_detect_outbound_proxy: true,
            accounts_file: "".to_string(),
            bun_path: "".to_string(),
            auto_start_core: true,
            auto_start_on_boot: false,
            start_minimized: false,
            minimize_to_tray: true,
            auto_restart_on_crash: true,
        }
    }
}

#[derive(Clone)]
pub struct CoreProcessManager {
    child: Arc<Mutex<Option<Child>>>,
    start_time: Arc<Mutex<Option<Instant>>>,
    state: Arc<Mutex<String>>,
    error_message: Arc<Mutex<Option<String>>>,
    config: Arc<Mutex<AppConfig>>,
    config_path: PathBuf,
    effective_outbound_proxy: Arc<Mutex<Option<String>>>,
    manual_stop: Arc<AtomicBool>,
    app_handle: AppHandle,
}

impl CoreProcessManager {
    pub fn new(app_handle: AppHandle) -> Self {
        let config_path = Self::config_path(&app_handle);
        let loaded_cfg = Self::load_config_file(&config_path).unwrap_or_default();
        let config = Self::normalize_config(loaded_cfg);

        Self {
            child: Arc::new(Mutex::new(None)),
            start_time: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new("STOPPED".to_string())),
            error_message: Arc::new(Mutex::new(None)),
            config: Arc::new(Mutex::new(config)),
            config_path,
            effective_outbound_proxy: Arc::new(Mutex::new(None)),
            manual_stop: Arc::new(AtomicBool::new(false)),
            app_handle,
        }
    }

    fn config_path(app_handle: &AppHandle) -> PathBuf {
        app_handle
            .path()
            .app_config_dir()
            .map(|dir| dir.join("gui-config.json"))
            .unwrap_or_else(|_| {
                if let Ok(exe_path) = std::env::current_exe() {
                    if let Some(exe_dir) = exe_path.parent() {
                        return exe_dir.join("data").join("gui-config.json");
                    }
                }
                PathBuf::from(r"data\gui-config.json")
            })
    }

    fn load_config_file(path: &Path) -> Option<AppConfig> {
        if !path.exists() {
            return None;
        }

        match fs::read_to_string(path)
            .map_err(|err| err.to_string())
            .and_then(|text| {
                serde_json::from_str::<AppConfig>(&text).map_err(|err| err.to_string())
            }) {
            Ok(config) => Some(config),
            Err(err) => {
                eprintln!("[GUI Config] Failed to load {}: {}", path.display(), err);
                None
            }
        }
    }

    fn normalize_config(mut config: AppConfig) -> AppConfig {
        // 8000 was the legacy default and conflicts with common local tools.
        // Existing installations are migrated automatically to the new port.
        if config.core_port == 8000 {
            config.core_port = 8317;
        }
        if config.core_dir.trim().is_empty() {
            config.core_dir = Self::detect_core_dir();
        }
        if config.accounts_file.trim().is_empty() {
            config.accounts_file = Self::detect_accounts_file();
        }
        if config.bun_path.trim().is_empty() {
            config.bun_path = Self::detect_bun_path();
        }
        config
    }

    fn persist_config(&self, config: &AppConfig) -> Result<(), String> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("无法创建 GUI 配置目录 {}: {}", parent.display(), err))?;
        }
        let json = serde_json::to_string_pretty(config)
            .map_err(|err| format!("无法序列化 GUI 配置: {}", err))?;
        fs::write(&self.config_path, json)
            .map_err(|err| format!("无法保存 GUI 配置 {}: {}", self.config_path.display(), err))
    }

    pub fn detect_core_dir() -> String {
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("core"),
            PathBuf::from("proxy"),
            PathBuf::from("../core"),
            PathBuf::from("../proxy"),
            PathBuf::from("../../core"),
            PathBuf::from("../../proxy"),
        ];

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join("core"));
                candidates.push(exe_dir.join("proxy"));
                if let Some(parent) = exe_dir.parent() {
                    candidates.push(parent.join("core"));
                    candidates.push(parent.join("proxy"));
                }
            }
        }

        for p in &candidates {
            if p.join("src").join("server.ts").exists() {
                if let Ok(canon) = p.canonicalize() {
                    return canon.to_string_lossy().to_string().replace(r"\\?\", "");
                }
                return p.to_string_lossy().to_string();
            }
        }
        "core".to_string()
    }

    pub fn detect_bun_path() -> String {
        let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
        let npm_bun = format!(r"{}\AppData\Roaming\npm\node_modules\bun\bin\bun.exe", user_profile);
        let npm_bun_cmd = format!(r"{}\AppData\Roaming\npm\bun.cmd", user_profile);
        let default_bun = format!(r"{}\.bun\bin\bun.exe", user_profile);

        let candidates = [
            npm_bun.as_str(),
            npm_bun_cmd.as_str(),
            default_bun.as_str(),
            "bun.exe",
            "bun",
        ];
        for c in candidates {
            if !c.is_empty() && Path::new(c).exists() {
                return c.to_string();
            }
        }
        "bun".to_string()
    }

    pub fn detect_accounts_file() -> String {
        let mut candidates: Vec<PathBuf> = vec![
            PathBuf::from("data/antigravity-accounts.json"),
            PathBuf::from("../data/antigravity-accounts.json"),
            PathBuf::from("../../data/antigravity-accounts.json"),
        ];

        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join("data").join("antigravity-accounts.json"));
                if let Some(parent) = exe_dir.parent() {
                    candidates.push(parent.join("data").join("antigravity-accounts.json"));
                }
            }
        }

        for path in &candidates {
            if path.exists() {
                if let Ok(canonical) = path.canonicalize() {
                    return canonical
                        .to_string_lossy()
                        .to_string()
                        .replace(r"\\?\", "");
                }
                return path.to_string_lossy().to_string();
            }
        }
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir
                    .join("data")
                    .join("antigravity-accounts.json")
                    .to_string_lossy()
                    .to_string();
            }
        }
        "data/antigravity-accounts.json".to_string()
    }

    pub async fn get_config(&self) -> AppConfig {
        self.config.lock().await.clone()
    }

    pub async fn save_config(&self, new_cfg: AppConfig) -> Result<(), String> {
        // Empty path fields mean "auto detect" in the UI. Resolve them before
        // storing the configuration so a settings save cannot silently switch
        // the Core back to an empty accounts file in its working directory.
        let new_cfg = Self::normalize_config(new_cfg);
        let old_cfg = self.config.lock().await.clone();
        let runtime_changed = Self::runtime_config_changed(&old_cfg, &new_cfg);

        self.persist_config(&new_cfg)?;
        *self.config.lock().await = new_cfg;

        let running = self.state.lock().await.as_str() == "RUNNING";
        if runtime_changed && running {
            self.restart().await?;
        }
        Ok(())
    }

    fn runtime_config_changed(old: &AppConfig, new: &AppConfig) -> bool {
        old.core_dir != new.core_dir
            || old.core_host != new.core_host
            || old.core_port != new.core_port
            || old.core_watch_mode != new.core_watch_mode
            || old.outbound_proxy != new.outbound_proxy
            || old.auto_detect_outbound_proxy != new.auto_detect_outbound_proxy
            || old.accounts_file != new.accounts_file
            || old.bun_path != new.bun_path
    }

    async fn proxy_is_reachable(proxy: &str) -> bool {
        let endpoint = proxy
            .strip_prefix("http://")
            .or_else(|| proxy.strip_prefix("https://"))
            .or_else(|| proxy.strip_prefix("socks5://"))
            .unwrap_or(proxy)
            .split('/')
            .next()
            .unwrap_or("");

        if endpoint.is_empty() {
            return false;
        }

        matches!(
            tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(endpoint)).await,
            Ok(Ok(_))
        )
    }

    async fn managed_proxy_is_listening(host: &str, port: u16) -> bool {
        let Ok(Ok(mut stream)) =
            tokio::time::timeout(Duration::from_secs(1), TcpStream::connect((host, port))).await
        else {
            return false;
        };

        let request = format!(
            "GET /api/status HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n",
            host, port
        );
        if tokio::time::timeout(Duration::from_secs(1), stream.write_all(request.as_bytes()))
            .await
            .is_err()
        {
            return false;
        }

        let mut response = Vec::new();
        if tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
            .await
            .is_err()
        {
            return false;
        }

        let text = String::from_utf8_lossy(&response);
        text.starts_with("HTTP/1.1 200") && text.contains("\"accounts\"")
    }

    #[cfg(windows)]
    async fn listening_pid(port: u16) -> Option<u32> {
        let mut netstat = Command::new("netstat");
        netstat
            .args(&["-ano", "-p", "tcp"])
            .creation_flags(0x08000000);
        let output = netstat.output().await.ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);

        stdout.lines().find_map(|line| {
            let columns: Vec<&str> = line.split_whitespace().collect();
            if columns.len() < 5 || !columns[1].ends_with(&format!(":{}", port)) {
                return None;
            }
            if !columns[3].eq_ignore_ascii_case("LISTENING") {
                return None;
            }
            columns[4].parse::<u32>().ok()
        })
    }

    async fn wait_for_port_release(host: &str, port: u16, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if TcpStream::connect((host, port)).await.is_err() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    async fn resolve_outbound_proxy(config: &AppConfig) -> Option<String> {
        let configured = config.outbound_proxy.trim();
        if !config.auto_detect_outbound_proxy {
            return (!configured.is_empty()).then(|| configured.to_string());
        }

        let mut candidates = Vec::new();
        if !configured.is_empty() {
            candidates.push(configured.to_string());
        }
        for port in [7897_u16, 7892, 7890, 7891, 7893, 1080] {
            let candidate = format!("http://127.0.0.1:{}", port);
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }

        for candidate in candidates {
            if Self::proxy_is_reachable(&candidate).await {
                return Some(candidate);
            }
        }
        None
    }

    pub fn get_status(&self) -> ProcessStatus {
        // Status is queried on initial page load and must never wait behind a
        // lifecycle operation. A blocked async mutex here stalls Tauri's invoke
        // dispatch and freezes the WebView (including JavaScript timers).
        let state = self
            .state
            .try_lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| "STARTING".to_string());
        let err = self
            .error_message
            .try_lock()
            .map(|guard| guard.clone())
            .unwrap_or(None);
        let cfg = self
            .config
            .try_lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| {
                let mut fallback = AppConfig::default();
                fallback.core_dir = Self::detect_core_dir();
                fallback.bun_path = Self::detect_bun_path();
                fallback.accounts_file = Self::detect_accounts_file();
                fallback
            });
        let uptime = if state == "RUNNING" {
            if let Ok(start_time) = self.start_time.try_lock() {
                if let Some(t) = *start_time {
                    t.elapsed().as_secs()
                } else {
                    0
                }
            } else {
                0
            }
        } else {
            0
        };

        let pid = self
            .child
            .try_lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|child| child.id()));

        let effective_outbound_proxy = self
            .effective_outbound_proxy
            .try_lock()
            .ok()
            .and_then(|guard| guard.clone());

        ProcessStatus {
            state,
            pid,
            host: cfg.core_host,
            port: cfg.core_port,
            core_dir: if cfg.core_dir.is_empty() {
                Self::detect_core_dir()
            } else {
                cfg.core_dir
            },
            watch_mode: cfg.core_watch_mode,
            uptime,
            active_accounts_count: 0,
            outbound_proxy: effective_outbound_proxy.or_else(|| {
                if cfg.outbound_proxy.is_empty() {
                    None
                } else {
                    Some(cfg.outbound_proxy)
                }
            }),
            error_message: err,
        }
    }

    pub async fn start(&self) -> Result<String, String> {
        {
            let state = self.state.lock().await;
            if *state == "RUNNING" || *state == "STARTING" {
                return Ok("服务已在运行或启动中".to_string());
            }
        }

        let cfg = self.config.lock().await.clone();
        let effective_outbound_proxy = Self::resolve_outbound_proxy(&cfg).await;
        let core_dir = if cfg.core_dir.is_empty() {
            Self::detect_core_dir()
        } else {
            cfg.core_dir
        };
        let configured_accounts_file = if cfg.accounts_file.trim().is_empty() {
            Self::detect_accounts_file()
        } else {
            cfg.accounts_file.clone()
        };
        // Resolve before changing the child working directory to core_dir.
        // Otherwise "data/..." would be interpreted as "core/data/..." by Bun.
        let accounts_file = Path::new(&configured_accounts_file)
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string().replace("\\\\?\\", ""))
            .unwrap_or(configured_accounts_file);
        let server_script = Path::new(&core_dir).join("src").join("server.ts");

        if !server_script.exists() {
            let msg = format!("未找到 Core 核心脚本: {}", server_script.display());
            *self.error_message.lock().await = Some(msg.clone());
            *self.state.lock().await = "ERROR".to_string();
            return Err(msg);
        }

        self.manual_stop.store(false, Ordering::SeqCst);
        // Never keep the status lock across process creation, event emission or
        // another async lock. The renderer asks for status during auto-start;
        // holding this guard made that first command wait indefinitely and left
        // the whole UI on "检测中".
        *self.state.lock().await = "STARTING".to_string();
        *self.error_message.lock().await = None;

        let bun_bin = if cfg.bun_path.is_empty() {
            Self::detect_bun_path()
        } else {
            cfg.bun_path
        };
        let mut cmd = Command::new(&bun_bin);

        if cfg.core_watch_mode {
            cmd.args(&["run", "--watch", "src/server.ts"]);
        } else {
            cmd.args(&["run", "src/server.ts"]);
        }

        cmd.current_dir(&core_dir);
        cmd.env("HOST", &cfg.core_host);
        cmd.env("PORT", cfg.core_port.to_string());
        // Always pass an explicit storage path. Otherwise Bun falls back to
        // <core_dir>/antigravity-accounts.json, which may be a different and
        // empty account store depending on how the GUI was launched.
        cmd.env("ACCOUNTS_FILE", &accounts_file);
        println!("[CoreProcess] Accounts file: {}", accounts_file);

        *self.effective_outbound_proxy.lock().await = effective_outbound_proxy.clone();

        if let Some(proxy) = effective_outbound_proxy {
            println!("[CoreProcess] Outbound proxy: {}", proxy);
            cmd.env("HTTP_PROXY", &proxy);
            cmd.env("HTTPS_PROXY", &proxy);
            cmd.env("NO_PROXY", "127.0.0.1,localhost");
            cmd.env("NODE_TLS_REJECT_UNAUTHORIZED", "0");
        } else if cfg.auto_detect_outbound_proxy {
            cmd.env("NODE_TLS_REJECT_UNAUTHORIZED", "0");
            eprintln!(
                "[CoreProcess] No reachable local outbound proxy detected; using direct connection"
            );
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        match cmd.spawn() {
            Ok(mut child) => {
                let pid = child.id().unwrap_or(0);
                println!("[CoreProcess] Spawned Bun Core with PID: {}", pid);

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                let app_handle_out = self.app_handle.clone();
                if let Some(out) = stdout {
                    tauri::async_runtime::spawn(async move {
                        let mut reader = BufReader::new(out).lines();
                        while let Ok(Some(line)) = reader.next_line().await {
                            let now = chrono::Local::now().format("%H:%M:%S").to_string();
                            let log_item = serde_json::json!({
                                "timestamp": now,
                                "level": if line.contains("ERROR") { "error" } else if line.contains("WARN") { "warn" } else if line.contains("/v1/") || line.contains("[Request Body]") { "request" } else { "info" },
                                "message": line,
                                "raw": line
                            });
                            let _ = app_handle_out.emit("core:log", log_item);
                        }
                    });
                }

                let app_handle_err = self.app_handle.clone();
                if let Some(err) = stderr {
                    tauri::async_runtime::spawn(async move {
                        let mut reader = BufReader::new(err).lines();
                        while let Ok(Some(line)) = reader.next_line().await {
                            let now = chrono::Local::now().format("%H:%M:%S").to_string();
                            let log_item = serde_json::json!({
                                "timestamp": now,
                                "level": "error",
                                "message": line,
                                "raw": line
                            });
                            let _ = app_handle_err.emit("core:log", log_item);
                        }
                    });
                }

                *self.child.lock().await = Some(child);
                *self.start_time.lock().await = Some(Instant::now());
                *self.state.lock().await = "RUNNING".to_string();

                let _ = self
                    .app_handle
                    .emit("core:status", serde_json::json!({ "state": "RUNNING" }));
                Ok("Core 服务已成功启动".to_string())
            }
            Err(e) => {
                let msg = format!("启动核心进程失败: {}", e);
                *self.error_message.lock().await = Some(msg.clone());
                *self.state.lock().await = "ERROR".to_string();
                let _ = self.app_handle.emit(
                    "core:status",
                    serde_json::json!({ "state": "ERROR", "error": msg }),
                );
                Err(msg)
            }
        }
    }

    pub async fn stop(&self) -> Result<String, String> {
        self.manual_stop.store(true, Ordering::SeqCst);
        *self.state.lock().await = "STOPPING".to_string();
        let cfg = self.config.lock().await.clone();

        // Remove the child from shared state before waiting for taskkill. Status
        // requests remain responsive while Windows tears down the process tree.
        let child = self.child.lock().await.take();
        let mut stopped_pid = None;
        if let Some(child) = child {
            if let Some(pid) = child.id() {
                stopped_pid = Some(pid);
                #[cfg(windows)]
                {
                    let mut taskkill = Command::new("taskkill");
                    taskkill
                        .args(&["/pid", &pid.to_string(), "/T", "/F"])
                        .creation_flags(0x08000000);
                    let _ = taskkill.output().await;
                }
                #[cfg(not(windows))]
                {
                    let mut c = child;
                    let _ = c.kill().await;
                }
            }
        }

        #[cfg(windows)]
        if stopped_pid.is_none()
            && Self::managed_proxy_is_listening(&cfg.core_host, cfg.core_port).await
        {
            if let Some(pid) = Self::listening_pid(cfg.core_port).await {
                let mut taskkill = Command::new("taskkill");
                taskkill
                    .args(&["/pid", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000);
                let output = taskkill
                    .output()
                    .await
                    .map_err(|err| format!("无法停止已接管的 Core 进程 {}: {}", pid, err))?;
                if !output.status.success() {
                    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    *self.state.lock().await = "ERROR".to_string();
                    return Err(format!("无法停止已接管的 Core 进程 {}: {}", pid, detail));
                }
                stopped_pid = Some(pid);
            }
        }

        if stopped_pid.is_some()
            && !Self::wait_for_port_release(&cfg.core_host, cfg.core_port, Duration::from_secs(5))
                .await
        {
            *self.state.lock().await = "ERROR".to_string();
            return Err(format!(
                "Core 进程已结束，但端口 {} 在超时后仍被占用",
                cfg.core_port
            ));
        }

        *self.state.lock().await = "STOPPED".to_string();
        *self.start_time.lock().await = None;
        let _ = self
            .app_handle
            .emit("core:status", serde_json::json!({ "state": "STOPPED" }));
        Ok("服务已停止".to_string())
    }

    pub async fn restart(&self) -> Result<String, String> {
        let _ = self.stop().await;
        tokio::time::sleep(tokio::time::Duration::from_millis(600)).await;
        self.start().await
    }
}
