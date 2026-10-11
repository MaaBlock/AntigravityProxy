import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AccountInfo, AppConfig, LogEntry, RuntimeSnapshot, ServiceStatus } from "./types";

export const DEFAULT_PORT = 8317;
const MAX_LOGS = 1200;
const GLOBAL_LLM_CONFIG_KEY = "antigravity:llm-config";

const initialStatus: ServiceStatus = {
  state: "STOPPED",
  pid: null,
  host: "127.0.0.1",
  port: DEFAULT_PORT,
  coreDir: "",
  watchMode: false,
  uptime: 0,
  activeAccountsCount: 0,
  outboundProxy: null,
  errorMessage: null,
};

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

function migrateGlobalPluginDefaults(): void {
  try {
    const raw = window.localStorage.getItem(GLOBAL_LLM_CONFIG_KEY) || window.localStorage.getItem("mablock:llm-config");
    const config = raw ? JSON.parse(raw) as Record<string, unknown> : {
      provider: "antigravity",
      apiKey: "sk-local",
      model: "gemini-3.7-flash-high",
      temperature: 0.7,
      maxTokens: 65536,
      streaming: true,
    };
    const baseUrl = String(config.baseUrl || `http://127.0.0.1:${DEFAULT_PORT}/v1`);
    config.baseUrl = baseUrl.replace(/([:/])8000(?=\/|$)/, `$1${DEFAULT_PORT}`);
    window.localStorage.setItem(GLOBAL_LLM_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // A corrupt preference must not prevent the host from starting.
  }
}

function normalizeStatus(raw: Record<string, unknown>): Partial<ServiceStatus> {
  return {
    state: (raw.state as ServiceStatus["state"]) || "STOPPED",
    pid: (raw.pid as number | null) ?? null,
    host: String(raw.host || "127.0.0.1"),
    port: Number(raw.port || DEFAULT_PORT),
    coreDir: String(raw.core_dir || raw.coreDir || ""),
    watchMode: Boolean(raw.watch_mode ?? raw.watchMode),
    uptime: Number(raw.uptime || 0),
    activeAccountsCount: Number(raw.active_accounts_count ?? raw.activeAccountsCount ?? 0),
    outboundProxy: (raw.outbound_proxy ?? raw.outboundProxy ?? null) as string | null,
    errorMessage: (raw.error_message ?? raw.errorMessage ?? null) as string | null,
  };
}

function normalizeLog(raw: unknown): LogEntry {
  const source = typeof raw === "object" && raw ? (raw as Record<string, unknown>) : { raw };
  const candidate = String(source.level || "info").toLowerCase();
  const level = ["info", "warn", "error", "request", "system"].includes(candidate)
    ? (candidate as LogEntry["level"])
    : "info";
  const message = String(source.raw ?? source.message ?? raw ?? "");
  return {
    id: String(source.id ?? `${Date.now()}-${Math.random()}`),
    timestamp: String(source.timestamp || new Date().toLocaleTimeString("zh-CN", { hour12: false })),
    level,
    message: message.length > 16000 ? `${message.slice(0, 16000)}…` : message,
  };
}

function normalizeAccounts(raw: unknown): AccountInfo[] {
  const payload = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).accounts)
      ? (raw as Record<string, unknown>).accounts as unknown[]
      : [];

  return payload
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const rawModels = item.supportedModels ?? item.supported_models ?? item.models;
      const models = Array.isArray(rawModels)
        ? rawModels.map(String)
        : rawModels instanceof Set
          ? [...rawModels].map(String)
          : [];
      return {
        email: typeof item.email === "string" ? item.email : undefined,
        projectId: typeof (item.projectId ?? item.project_id) === "string"
          ? String(item.projectId ?? item.project_id)
          : undefined,
        health: Number.isFinite(Number(item.health)) ? Number(item.health) : undefined,
        healthScore: Number.isFinite(Number(item.healthScore ?? item.health_score))
          ? Number(item.healthScore ?? item.health_score)
          : undefined,
        models,
        supportedModels: models,
      };
    });
}

function normalizeConfig(raw: Record<string, unknown>): AppConfig {
  return {
    coreDir: String(raw.core_dir || ""),
    coreHost: String(raw.core_host || "127.0.0.1"),
    corePort: Number(raw.core_port || DEFAULT_PORT),
    coreWatchMode: Boolean(raw.core_watch_mode),
    outboundProxy: String(raw.outbound_proxy || ""),
    autoDetectOutboundProxy: Boolean(raw.auto_detect_outbound_proxy),
    accountsFile: String(raw.accounts_file || ""),
    bunPath: String(raw.bun_path || ""),
    autoStartCore: Boolean(raw.auto_start_core),
    autoStartOnBoot: Boolean(raw.auto_start_on_boot),
    startMinimized: Boolean(raw.start_minimized),
    minimizeToTray: Boolean(raw.minimize_to_tray),
    autoRestartOnCrash: Boolean(raw.auto_restart_on_crash),
  };
}

class RuntimeStore {
  private snapshot: RuntimeSnapshot = {
    status: initialStatus,
    logs: [],
    accounts: [],
    config: null,
    connected: false,
    busyAction: null,
  };
  private listeners = new Set<() => void>();
  private unlisten: UnlistenFn[] = [];
  private started = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private updateStatus(patch: Partial<ServiceStatus>): void {
    this.update({ status: { ...this.snapshot.status, ...patch } });
  }

  private appendLog(raw: unknown): void {
    const entry = normalizeLog(raw);
    const previous = this.snapshot.logs.at(-1);
    if (previous && previous.message === entry.message && previous.level === entry.level) return;
    this.update({ logs: [...this.snapshot.logs, entry].slice(-MAX_LOGS) });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    migrateGlobalPluginDefaults();
    if (!inTauri()) {
      this.appendLog({ level: "system", message: "浏览器预览模式：原生 Core 命令不可用" });
      return;
    }
    try {
      this.unlisten.push(
        await listen<Record<string, unknown>>("core:status", (event) => this.updateStatus(normalizeStatus(event.payload))),
        await listen<unknown>("core:log", (event) => this.appendLog(event.payload)),
        await listen<unknown>("core:accounts", (event) => this.update({ accounts: normalizeAccounts(event.payload) })),
        await listen<boolean>("core:ipc_connected", (event) => this.update({ connected: event.payload })),
      );
    } catch (err) {
      console.warn("Failed to attach Tauri event listeners:", err);
    }
    await Promise.allSettled([this.refreshStatus(), this.loadConfig(), this.loadLogs()]);
  }

  stop(): void {
    this.unlisten.splice(0).forEach((fn) => fn());
    this.started = false;
  }

  async refreshStatus(): Promise<void> {
    if (!inTauri()) return;
    const raw = await invoke<Record<string, unknown>>("core_get_status");
    this.updateStatus(normalizeStatus(raw));
  }

  private async lifecycle(command: "core_start" | "core_stop" | "core_restart"): Promise<string> {
    this.update({ busyAction: command });
    try {
      const result = await invoke<string>(command);
      await this.refreshStatus();
      return result;
    } finally {
      this.update({ busyAction: null });
    }
  }

  startCore = (): Promise<string> => this.lifecycle("core_start");
  stopCore = (): Promise<string> => this.lifecycle("core_stop");
  restartCore = (): Promise<string> => this.lifecycle("core_restart");

  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>("core_rpc", { method, params });
  }

  async loadLogs(): Promise<void> {
    try {
      const logs = await this.rpc<unknown[]>("logs.get");
      this.update({ logs: (logs || []).slice(-MAX_LOGS).map(normalizeLog) });
    } catch {
      // Core may not be running yet.
    }
  }

  async clearLogs(): Promise<void> {
    try { await this.rpc("logs.clear"); } catch { /* clear local buffer anyway */ }
    this.update({ logs: [] });
  }

  async loadAccounts(): Promise<void> {
    const accounts = await this.rpc<unknown>("accounts.list");
    this.update({ accounts: normalizeAccounts(accounts) });
  }

  async refreshAccounts(): Promise<void> {
    if (!inTauri()) return;
    await this.rpc("quota.refresh");
    await this.loadAccounts();
  }

  async loadConfig(): Promise<AppConfig | null> {
    if (!inTauri()) return null;
    const raw = await invoke<Record<string, unknown>>("get_config");
    const config = normalizeConfig(raw);
    this.update({ config });
    return config;
  }

  async saveConfig(config: AppConfig): Promise<void> {
    if (!inTauri()) {
      this.update({ config });
      return;
    }
    const raw = await invoke<Record<string, unknown>>("save_config", {
      config: {
        core_dir: config.coreDir,
        core_host: config.coreHost,
        core_port: config.corePort,
        core_watch_mode: config.coreWatchMode,
        outbound_proxy: config.outboundProxy,
        auto_detect_outbound_proxy: config.autoDetectOutboundProxy,
        accounts_file: config.accountsFile,
        bun_path: config.bunPath,
        auto_start_core: config.autoStartCore,
        auto_start_on_boot: config.autoStartOnBoot,
        start_minimized: config.startMinimized,
        minimize_to_tray: config.minimizeToTray,
        auto_restart_on_crash: config.autoRestartOnCrash,
      },
    });
    this.update({ config: normalizeConfig(raw) });
  }

  openExternal(url: string): Promise<void> {
    if (!inTauri()) {
      window.open(url, "_blank");
      return Promise.resolve();
    }
    return invoke("open_external", { url });
  }

  openPath(path: string): Promise<void> {
    if (!inTauri()) {
      return Promise.resolve();
    }
    return invoke("open_path", { path });
  }
}

export const runtime = new RuntimeStore();
