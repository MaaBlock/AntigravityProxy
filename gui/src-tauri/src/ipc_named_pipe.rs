use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};
use tauri::{async_runtime::spawn, AppHandle, Emitter};

pub const PIPE_NAME: &str = r"\\.\pipe\antigravity_proxy_ipc";

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

pub struct NamedPipeClient {
    req_tx: mpsc::Sender<(JsonRpcRequest, oneshot::Sender<Result<Value, String>>)>,
    id_counter: AtomicU64,
    is_connected: Arc<AtomicBool>,
}

impl NamedPipeClient {
    pub fn new(app_handle: AppHandle) -> Self {
        let (req_tx, mut req_rx) = mpsc::channel::<(JsonRpcRequest, oneshot::Sender<Result<Value, String>>)>(100);
        let is_connected = Arc::new(AtomicBool::new(false));
        let is_connected_bg = is_connected.clone();
        let app_handle_clone = app_handle.clone();

        spawn(async move {
            loop {
                // Connect to Windows Named Pipe
                #[cfg(windows)]
                let pipe_res = tokio::net::windows::named_pipe::ClientOptions::new().open(PIPE_NAME);
                #[cfg(not(windows))]
                let pipe_res = tokio::net::UnixStream::connect("/tmp/antigravity_proxy_ipc.sock").await;

                match pipe_res {
                    Ok(pipe) => {
                        println!("[NamedPipe IPC] Connected to Core Named Pipe IPC: {}", PIPE_NAME);
                        is_connected_bg.store(true, Ordering::SeqCst);
                        let _ = app_handle_clone.emit("core:ipc_connected", true);

                        let (reader, mut writer) = tokio::io::split(pipe);
                        let mut buf_reader = BufReader::new(reader);

                        // Subscribe to all topics on connect
                        let sub_msg = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 0,
                            "method": "events.subscribe",
                            "params": { "topics": ["all"] }
                        });
                        let _ = writer.write_all(format!("{}\n", sub_msg).as_bytes()).await;
                        let _ = writer.flush().await;

                        let pending_map = Arc::new(Mutex::new(std::collections::HashMap::<u64, oneshot::Sender<Result<Value, String>>>::new()));
                        let pending_map_reader = pending_map.clone();
                        let app_handle_events = app_handle_clone.clone();

                        let reader_alive = Arc::new(AtomicBool::new(true));
                        let reader_alive_clone = reader_alive.clone();

                        // Spawn reader task
                        spawn(async move {
                            let mut line = String::new();
                            loop {
                                line.clear();
                                match buf_reader.read_line(&mut line).await {
                                    Ok(0) => {
                                        println!("[NamedPipe IPC] Disconnected from Core Named Pipe");
                                        break;
                                    }
                                    Ok(_) => {
                                        let trimmed = line.trim();
                                        if trimmed.is_empty() {
                                            continue;
                                        }

                                        if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                                            // Check if it's a notification/event
                                            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                                                if method.starts_with("event.") {
                                                    let event_topic = &method[6..];
                                                    let params = v.get("params").cloned().unwrap_or(Value::Null);

                                                    match event_topic {
                                                        "logs" => {
                                                            let _ = app_handle_events.emit("core:log", params);
                                                        }
                                                        "status" => {
                                                            let _ = app_handle_events.emit("core:status", params);
                                                        }
                                                        "accounts" => {
                                                            let _ = app_handle_events.emit("core:accounts", params);
                                                        }
                                                        _ => {
                                                            let _ = app_handle_events.emit(&format!("core:{}", event_topic), params);
                                                        }
                                                    }
                                                }
                                            } else if let Some(id_val) = v.get("id").and_then(|i| i.as_u64()) {
                                                let mut lock = pending_map_reader.lock().await;
                                                if let Some(responder) = lock.remove(&id_val) {
                                                    if let Some(err) = v.get("error") {
                                                        let _ = responder.send(Err(err.to_string()));
                                                    } else {
                                                        let res = v.get("result").cloned().unwrap_or(Value::Null);
                                                        let _ = responder.send(Ok(res));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        println!("[NamedPipe IPC] Read error: {}", e);
                                        break;
                                    }
                                }
                            }
                            reader_alive_clone.store(false, Ordering::SeqCst);
                        });

                        // Writer loop for incoming RPC calls
                        loop {
                            tokio::select! {
                                req_opt = req_rx.recv() => {
                                    match req_opt {
                                        Some((req, responder)) => {
                                            if let Some(id) = req.id {
                                                pending_map.lock().await.insert(id, responder);
                                            }
                                            let json_str = serde_json::to_string(&req).unwrap();
                                            if let Err(e) = writer.write_all(format!("{}\n", json_str).as_bytes()).await {
                                                println!("[NamedPipe IPC] Write error: {}", e);
                                                break;
                                            }
                                            let _ = writer.flush().await;
                                        }
                                        None => break,
                                    }
                                }
                                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                                    if !reader_alive.load(Ordering::SeqCst) {
                                        break;
                                    }
                                }
                            }
                        }

                        is_connected_bg.store(false, Ordering::SeqCst);
                        let _ = app_handle_clone.emit("core:ipc_connected", false);

                        // Clear any pending requests with error
                        let mut lock = pending_map.lock().await;
                        for (_, responder) in lock.drain() {
                            let _ = responder.send(Err("Named pipe disconnected".to_string()));
                        }
                    }
                    Err(_) => {
                        is_connected_bg.store(false, Ordering::SeqCst);
                        // Drain any requests that come in while disconnected to avoid blocking callers
                        while let Ok((_, responder)) = req_rx.try_recv() {
                            let _ = responder.send(Err("Named pipe is not connected".to_string()));
                        }
                        tokio::time::sleep(Duration::from_millis(800)).await;
                    }
                }
            }
        });

        Self {
            req_tx,
            id_counter: AtomicU64::new(1),
            is_connected,
        }
    }

    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        if !self.is_connected.load(Ordering::SeqCst) {
            return Err("Named Pipe not connected to Core".to_string());
        }

        let id = self.id_counter.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(id),
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        self.req_tx
            .send((req, tx))
            .await
            .map_err(|_| "IPC channel closed".to_string())?;

        match tokio::time::timeout(Duration::from_millis(2500), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("IPC responder dropped".to_string()),
            Err(_) => Err("IPC Request Timeout (2.5s)".to_string()),
        }
    }
}
