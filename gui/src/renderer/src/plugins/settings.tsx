import React, { useEffect, useState } from "react";
import { FolderOpen, Globe, Laptop, RefreshCw, Save, Server, Shield } from "lucide-react";
import { runtime } from "../runtime";
import { Button, Card, Field, PageHeader, Toggle, useRuntime } from "../ui";
import { notify } from "../notification";
import type { AppConfig } from "../types";

const defaultSettings: AppConfig = {
  coreDir: "",
  coreHost: "127.0.0.1",
  corePort: 8317,
  coreWatchMode: false,
  outboundProxy: "",
  autoDetectOutboundProxy: true,
  accountsFile: "",
  bunPath: "",
  autoStartCore: true,
  autoStartOnBoot: false,
  startMinimized: false,
  minimizeToTray: true,
  autoRestartOnCrash: true,
};

export function SettingsView() {
  const { config: remoteConfig } = useRuntime();
  const [config, setConfig] = useState<AppConfig>(() => remoteConfig || defaultSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (remoteConfig) {
      setConfig(remoteConfig);
    }
  }, [remoteConfig]);

  useEffect(() => {
    runtime.loadConfig().then((loaded) => {
      if (loaded) setConfig(loaded);
    });
  }, []);

  const update = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: AppConfig = {
        ...config,
        corePort: config.corePort || 8317,
      };
      await runtime.saveConfig(payload);
      setConfig(payload);
      notify("success", "设置已成功保存并应用");
    } catch (error) {
      notify("error", `保存设置失败: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setConfig(defaultSettings);
    notify("info", "已重置为默认设置（请点击保存以应用）");
  };

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="PREFERENCES"
        title="系统与服务设置"
        description="配置 Core 反代进程、网络上游代理及桌面管理中心行为。"
        actions={
          <>
            <Button variant="ghost" onClick={handleReset} disabled={saving}>
              <RefreshCw size={14} />重置默认
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              <Save size={14} />{saving ? "正在保存…" : "保存设置"}
            </Button>
          </>
        }
      />

      <div className="settings-grid">
        {/* Core 反代服务配置 */}
        <Card className="settings-card">
          <div className="settings-section-title">
            <Server size={17} className="text-[var(--app-primary)]" />
            <span>Core 反代核心配置</span>
          </div>
          <p className="settings-section-desc">反代服务本地监听参数与运行环境配置。</p>

          <div className="settings-form-grid">
            <Field label="监听主机 (Host)" hint="默认 127.0.0.1，请勿绑定公网 IP">
              <input
                type="text"
                value={config.coreHost}
                onChange={(e) => update("coreHost", e.target.value)}
                placeholder="127.0.0.1"
              />
            </Field>

            <Field label="监听端口 (Port)" hint="默认 8317，请确保端口未被占用">
              <input
                type="number"
                value={config.corePort || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  update("corePort", val === "" ? 0 : parseInt(val, 10) || 0);
                }}
                placeholder="8317"
              />
            </Field>
          </div>

          <div className="settings-form-grid" style={{ marginTop: "12px" }}>
            <Field label="Core 源码根目录" hint="默认留空将自动寻址项目根目录下的 core 文件夹">
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="text"
                  style={{ flex: 1 }}
                  value={config.coreDir}
                  onChange={(e) => update("coreDir", e.target.value)}
                  placeholder="留空自动检测"
                />
                {config.coreDir && (
                  <Button variant="ghost" onClick={() => runtime.openPath(config.coreDir)}>
                    <FolderOpen size={14} />
                  </Button>
                )}
              </div>
            </Field>

            <Field label="Bun 可执行文件路径" hint="默认留空将从系统环境变量 PATH 中检索 bun">
              <input
                type="text"
                value={config.bunPath}
                onChange={(e) => update("bunPath", e.target.value)}
                placeholder="留空自动探测"
              />
            </Field>
          </div>

          <div style={{ marginTop: "12px" }}>
            <Field label="账号数据文件路径" hint="默认留空使用 data/antigravity-accounts.json">
              <input
                type="text"
                value={config.accountsFile}
                onChange={(e) => update("accountsFile", e.target.value)}
                placeholder="data/antigravity-accounts.json"
              />
            </Field>
          </div>

          <div className="settings-row" style={{ marginTop: "16px" }}>
            <div className="settings-row-info">
              <b>核心代码热重载 (Watch Mode)</b>
              <small>开启后修改 core/ 下的 TypeScript 源码将自动热重载，无需重启 GUI</small>
            </div>
            <Toggle
              checked={config.coreWatchMode}
              onChange={(v) => update("coreWatchMode", v)}
            />
          </div>
        </Card>

        {/* 上游代理配置 */}
        <Card className="settings-card">
          <div className="settings-section-title">
            <Globe size={17} className="text-[var(--app-primary)]" />
            <span>网络与上游代理</span>
          </div>
          <p className="settings-section-desc">配置请求 Google Cloud Code API 时的出站代理。</p>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>自动探测本机代理</b>
              <small>自动轮询探测本机 Clash / v2ray / Mihomo 等代理软件的活跃端口</small>
            </div>
            <Toggle
              checked={config.autoDetectOutboundProxy}
              onChange={(v) => update("autoDetectOutboundProxy", v)}
            />
          </div>

          <div style={{ marginTop: "14px" }}>
            <Field
              label="自定义出站代理 URL"
              hint="手动指定代理地址（如 http://127.0.0.1:7890），关闭自动探测时生效"
            >
              <input
                type="text"
                value={config.outboundProxy}
                onChange={(e) => update("outboundProxy", e.target.value)}
                disabled={config.autoDetectOutboundProxy}
                placeholder="http://127.0.0.1:7890"
              />
            </Field>
          </div>
        </Card>

        {/* 桌面客户端策略 */}
        <Card className="settings-card">
          <div className="settings-section-title">
            <Laptop size={17} className="text-[var(--app-primary)]" />
            <span>桌面客户端与系统行为</span>
          </div>
          <p className="settings-section-desc">Windows 系统集成、托盘与进程托管策略。</p>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>启动 GUI 时自动启动 Core</b>
              <small>打开桌面客户端时自动拉起后台反代核心服务</small>
            </div>
            <Toggle
              checked={config.autoStartCore}
              onChange={(v) => update("autoStartCore", v)}
            />
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>异常崩溃自动恢复</b>
              <small>当 Core 核心进程非预期退出时，自动执行健康检查并重新拉起</small>
            </div>
            <Toggle
              checked={config.autoRestartOnCrash}
              onChange={(v) => update("autoRestartOnCrash", v)}
            />
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>开机自启动</b>
              <small>Windows 开机后静默启动 Antigravity Proxy 客户端</small>
            </div>
            <Toggle
              checked={config.autoStartOnBoot}
              onChange={(v) => update("autoStartOnBoot", v)}
            />
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>启动时最小化</b>
              <small>客户端启动时不弹出主窗口，直接驻留于系统托盘</small>
            </div>
            <Toggle
              checked={config.startMinimized}
              onChange={(v) => update("startMinimized", v)}
            />
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <b>关闭窗口时最小化到系统托盘</b>
              <small>点击窗口右上角关闭按钮时隐藏至系统托盘，保持后台代理持续运行</small>
            </div>
            <Toggle
              checked={config.minimizeToTray}
              onChange={(v) => update("minimizeToTray", v)}
            />
          </div>
        </Card>

        {/* 关于 */}
        <Card className="settings-card">
          <div className="settings-section-title">
            <Shield size={17} className="text-[var(--app-primary)]" />
            <span>关于 Antigravity Proxy</span>
          </div>
          <p className="settings-section-desc">轻量、纯粹、解耦的高性能反代核心与桌面管理中心。</p>

          <div style={{ display: "grid", gap: "10px", fontSize: "12px", color: "var(--app-muted-fg)" }}>
            <div><b>版本</b>: 2.0.0 (Native Tauri 2 + Bun Core)</div>
            <div><b>通信架构</b>: Windows Named Pipe JSON-RPC 2.0 + SSE 事件流</div>
            <div><b>GitHub 仓库</b>: <a href="https://github.com/MaaBlock/AntigravityProxy" target="_blank" rel="noreferrer" style={{ color: "var(--app-primary)", textDecoration: "underline" }}>https://github.com/MaaBlock/AntigravityProxy</a></div>
          </div>
        </Card>
      </div>
    </div>
  );
}
