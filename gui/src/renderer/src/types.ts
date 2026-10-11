export type ServiceState = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR";

export interface ServiceStatus {
  state: ServiceState;
  pid: number | null;
  host: string;
  port: number;
  coreDir: string;
  watchMode: boolean;
  uptime: number;
  activeAccountsCount: number;
  outboundProxy: string | null;
  errorMessage: string | null;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "request" | "system";
  message: string;
}

export interface AccountInfo {
  email?: string;
  projectId?: string;
  health?: number;
  healthScore?: number;
  models?: string[];
  supportedModels?: string[];
}

export interface AppConfig {
  coreDir: string;
  coreHost: string;
  corePort: number;
  coreWatchMode: boolean;
  outboundProxy: string;
  autoDetectOutboundProxy: boolean;
  accountsFile: string;
  bunPath: string;
  autoStartCore: boolean;
  autoStartOnBoot: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  autoRestartOnCrash: boolean;
}

export interface RuntimeSnapshot {
  status: ServiceStatus;
  logs: LogEntry[];
  accounts: AccountInfo[];
  config: AppConfig | null;
  connected: boolean;
  busyAction: string | null;
}
