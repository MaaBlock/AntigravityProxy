import React, { createContext, useContext, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export type ThemeMode = "dark" | "light";

interface ThemeContextValue {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
}

const THEME_STORAGE_KEY = "antigravity_theme";

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  toggleTheme: () => {},
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // 本地存储不可用时忽略
    }
    return "dark";
  });

  const setTheme = (mode: ThemeMode) => {
    setThemeState(mode);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // 本地存储不可用时忽略
    }
  };

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme === "dark" ? "google-m3-dark" : "google-m3-light");
    if (theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
        compact
          ? "text-[var(--app-muted-fg)] hover:text-[var(--app-fg)] hover:bg-[var(--app-surface-hl)]"
          : "bg-[var(--app-card)] hover:bg-[var(--app-surface-hl)] text-[var(--app-fg)] border border-[var(--app-border)] shadow-sm"
      }`}
      title={`点击切换到 ${isDark ? "浅色模式" : "深色模式"}`}
    >
      {isDark ? (
        <Sun size={14} className="text-[var(--md-sys-color-tertiary)]" />
      ) : (
        <Moon size={14} className="text-[var(--app-primary)]" />
      )}
      {!compact && (
        <span className="text-[11px] font-mono">{isDark ? "M3 Dark" : "M3 Light"}</span>
      )}
    </button>
  );
}
