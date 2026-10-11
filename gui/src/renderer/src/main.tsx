import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LayoutDashboard, Settings2, Terminal, Users } from "lucide-react";
import { runtime } from "./runtime";
import { useRuntime } from "./ui";
import { ThemeProvider, ThemeSwitcher } from "./theme";
import { subscribeToasts, type Toast } from "./notification";
import { DashboardView } from "./plugins/dashboard";
import { LogsView } from "./plugins/logs";
import { AccountsView } from "./plugins/accounts";
import { SettingsView } from "./plugins/settings";
import "./styles.css";

const navItems = [
  { id: "antigravity.dashboard", name: "服务总览", icon: LayoutDashboard, component: DashboardView },
  { id: "antigravity.logs", name: "实时日志", icon: Terminal, component: LogsView },
  { id: "antigravity.accounts", name: "账号与额度", icon: Users, component: AccountsView },
  { id: "settings", name: "系统设置", icon: Settings2, component: SettingsView },
];

function Shell() {
  const requestedTab = window.location.hash.slice(1);
  const [active, setActive] = useState(
    navItems.some((item) => item.id === requestedTab) ? requestedTab : "antigravity.dashboard"
  );
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { status, connected } = useRuntime();

  useEffect(() => {
    return subscribeToasts((toast) => {
      setToasts((current) => [...current, toast].slice(-4));
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== toast.id));
      }, 3200);
    });
  }, []);

  const selectTab = (tabId: string) => {
    window.location.hash = tabId;
    setActive(tabId);
  };

  const currentItem = navItems.find((item) => item.id === active) || navItems[0];
  const ActiveComponent = currentItem.component;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><span /></div>
          <div><b>ANTIGRAVITY</b><small>Proxy Console</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isCurrent = active === item.id;
            return (
              <button
                key={item.id}
                className={isCurrent ? "active" : ""}
                onClick={() => selectTab(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{item.name}</span>
                {isCurrent && <i />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="kernel-card">
          <div><b>Antigravity Proxy</b><span>v2.0.0</span></div>
          <p>Tauri 2 · Native Desktop</p>
        </div>
        <div className="sidebar-status">
          <span className={`status-orb ${status.state.toLowerCase()}`} />
          <div>
            <b>Core {status.state === "RUNNING" ? "在线" : "离线"}</b>
            <small>{connected ? "IPC 已连接" : `${status.host}:${status.port}`}</small>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="global-header">
          <div>
            <span>ANTIGRAVITY PROXY</span>
            <b>{currentItem.name}</b>
          </div>
          <div className="header-plugin-slot">
            <ThemeSwitcher />
          </div>
        </header>
        <main className="content">
          <ActiveComponent />
        </main>
      </section>
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            <span />
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

async function bootstrap() {
  const root = createRoot(document.getElementById("root")!);
  try {
    await runtime.start();
    root.render(
      <StrictMode>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </StrictMode>
    );
  } catch (error) {
    root.render(
      <div className="fatal">
        <h1>客户端启动失败</h1>
        <pre>{String(error)}</pre>
      </div>
    );
  }
}

void bootstrap();
