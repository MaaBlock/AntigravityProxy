import { useSyncExternalStore, type ButtonHTMLAttributes, type PropsWithChildren, type ReactNode } from "react";
import { runtime } from "./runtime";

export function useRuntime() {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return <button className={`button ${variant} ${className}`} {...props} />;
}

export function StatePill({ state }: { state: string }) {
  const normalized = state.toLowerCase();
  const label: Record<string, string> = { running: "运行中", starting: "启动中", stopping: "停止中", stopped: "已停止", error: "异常" };
  return <span className={`state-pill ${normalized}`}><span className="state-dot" />{label[normalized] || state}</span>;
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" className={`toggle ${checked ? "on" : ""}`} aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours ? `${hours}h ` : ""}${minutes}m ${secs}s`;
}
