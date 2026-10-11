import { Activity, ArrowUpRight, Copy, FolderOpen, Play, RotateCw, Square, Users } from "lucide-react";
import { runtime } from "../runtime";
import { Button, Card, PageHeader, StatePill, copyText, formatUptime, useRuntime } from "../ui";
import { notify } from "../notification";

export function DashboardView() {
  const { status, logs, busyAction } = useRuntime();
  const baseUrl = `http://${status.host}:${status.port}/v1`;

  async function act(label: string, fn: () => Promise<string>) {
    notify("info", `${label}中…`);
    try {
      notify("success", await fn());
    } catch (error) {
      notify("error", `${label}失败：${String(error)}`);
    }
  }

  async function copy(value: string, message: string) {
    try {
      await copyText(value);
      notify("success", message);
    } catch {
      notify("error", "无法写入剪贴板");
    }
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="CORE OVERVIEW"
        title="服务总览"
        description="管理本地反代核心，并查看当前连接与运行状态。"
        actions={
          <>
            <Button onClick={() => act("启动", runtime.startCore)} disabled={status.state === "RUNNING" || !!busyAction}>
              <Play size={15} />启动
            </Button>
            <Button onClick={() => act("重启", runtime.restartCore)} disabled={status.state !== "RUNNING" || !!busyAction}>
              <RotateCw size={15} />重启
            </Button>
            <Button variant="danger" onClick={() => act("停止", runtime.stopCore)} disabled={status.state === "STOPPED" || !!busyAction}>
              <Square size={14} />停止
            </Button>
          </>
        }
      />

      <div className="metric-grid">
        <Card className="metric-card accent">
          <div className="metric-icon"><Activity size={19} /></div>
          <span className="metric-label">核心状态</span>
          <div className="metric-main"><StatePill state={status.state} /></div>
          <small>运行时间 {formatUptime(status.uptime)}</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-icon"><ArrowUpRight size={19} /></div>
          <span className="metric-label">监听端口</span>
          <strong>{status.port}</strong>
          <small>{status.host} · 本机回环</small>
        </Card>
        <Card className="metric-card">
          <div className="metric-icon"><Users size={19} /></div>
          <span className="metric-label">账号池</span>
          <strong>{status.activeAccountsCount}</strong>
          <small>{status.outboundProxy ? `代理 ${status.outboundProxy}` : "当前使用直连"}</small>
        </Card>
      </div>

      <div className="dashboard-grid">
        <Card className="endpoint-card">
          <div className="card-heading">
            <div><span>API ENDPOINT</span><h2>接入地址</h2></div>
            <div className="live-mark"><i />LOCAL</div>
          </div>
          <button className="endpoint-box" onClick={() => copy(baseUrl, "Base URL 已复制")}>
            <code>{baseUrl}</code>
            <Copy size={17} />
          </button>
          <div className="quick-grid">
            <button onClick={() => copy(`export CLAUDE_CODE_API_BASE="${baseUrl}"\nclaude --model gemini-3.1-pro-low`, "Claude Code 配置已复制")}>
              <b>CC</b>
              <span>Claude Code<small>复制启动配置</small></span>
            </button>
            <button onClick={() => copy(JSON.stringify({ provider: { "antigravity-proxy": { npm: "@ai-sdk/openai-compatible", name: "Antigravity Proxy", options: { baseURL: baseUrl } } } }, null, 2), "OpenCode 配置已复制")}>
              <b>OC</b>
              <span>OpenCode<small>复制 Provider JSON</small></span>
            </button>
            <button onClick={() => runtime.openExternal(`http://${status.host}:${status.port}/frontend/index.html`)}>
              <b>WEB</b>
              <span>网页控制台<small>在浏览器中打开</small></span>
            </button>
            <button onClick={() => runtime.openExternal(`http://${status.host}:${status.port}/oauth/start`)}>
              <b>+</b>
              <span>绑定账号<small>Google OAuth</small></span>
            </button>
          </div>
        </Card>

        <Card className="activity-card">
          <div className="card-heading">
            <div><span>LIVE ACTIVITY</span><h2>最近动态</h2></div>
            <span className="muted">{logs.length} 条</span>
          </div>
          <div className="mini-log-list">
            {logs.slice(-6).reverse().map((log) => (
              <div key={log.id}>
                <span className={`log-led ${log.level}`} />
                <time>{log.timestamp}</time>
                <p>{log.message}</p>
              </div>
            ))}
            {!logs.length && <div className="empty-inline">暂无运行日志</div>}
          </div>
        </Card>
      </div>

      <Card className="core-path-card">
        <div>
          <FolderOpen size={18} />
          <span><b>Core 源码目录</b><small>{status.coreDir || "尚未配置"}</small></span>
        </div>
        <Button variant="ghost" onClick={() => status.coreDir && runtime.openPath(status.coreDir)}>
          打开目录 <ArrowUpRight size={14} />
        </Button>
      </Card>
    </div>
  );
}
