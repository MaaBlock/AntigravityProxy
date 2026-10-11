import { useMemo, useState } from "react";
import { Check, Download, Eraser, Search } from "lucide-react";
import { runtime } from "../runtime";
import { Button, PageHeader, useRuntime } from "../ui";
import { notify } from "../notification";
import type { LogEntry } from "../types";

const levels: Array<{ value: "all" | LogEntry["level"]; label: string }> = [
  { value: "all", label: "全部" },
  { value: "info", label: "INFO" },
  { value: "request", label: "REQUEST" },
  { value: "warn", label: "WARN" },
  { value: "error", label: "ERROR" },
  { value: "system", label: "SYSTEM" },
];

export function LogsView() {
  const { logs } = useRuntime();
  const [level, setLevel] = useState<(typeof levels)[number]["value"]>("all");
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  const filtered = useMemo(
    () =>
      logs.filter(
        (log) =>
          (level === "all" || log.level === level) &&
          (!query || log.message.toLowerCase().includes(query.toLowerCase()))
      ),
    [logs, level, query]
  );

  function exportLogs() {
    const blob = new Blob(
      [
        filtered
          .map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`)
          .join("\n"),
      ],
      { type: "text/plain;charset=utf-8" }
    );
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `antigravity-proxy-${new Date().toISOString().slice(0, 10)}.log`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    notify("success", "日志已导出");
  }

  return (
    <div className="page logs-page">
      <PageHeader
        eyebrow="OBSERVABILITY"
        title="实时日志"
        description="来自 Core 标准输出与 Named Pipe 的统一事件流。"
        actions={
          <>
            <Button variant="ghost" onClick={() => setAutoScroll(!autoScroll)}>
              {autoScroll && <Check size={14} />}自动滚动
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void runtime.clearLogs();
                notify("info", "日志已清空");
              }}
            >
              <Eraser size={14} />清空
            </Button>
            <Button onClick={exportLogs}>
              <Download size={14} />导出
            </Button>
          </>
        }
      />
      <section className="terminal-card">
        <div className="terminal-toolbar">
          <div className="level-tabs">
            {levels.map((item) => (
              <button
                key={item.value}
                className={level === item.value ? "active" : ""}
                onClick={() => setLevel(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索日志"
            />
          </label>
        </div>
        <div className="terminal-body">
          {filtered.map((log) => (
            <div className="log-row" key={log.id}>
              <time>{log.timestamp}</time>
              <span className={`log-level ${log.level}`}>{log.level}</span>
              <pre>{log.message}</pre>
            </div>
          ))}
          {!filtered.length && <div className="empty-state">没有符合当前筛选条件的日志</div>}
          {autoScroll && <div aria-hidden="true" />}
        </div>
        <footer className="terminal-footer">
          <span>显示 {filtered.length} / {logs.length}</span>
          <span><i className="connected-dot" />Core 实时事件流</span>
        </footer>
      </section>
    </div>
  );
}
