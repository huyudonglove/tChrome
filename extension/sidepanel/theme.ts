// 侧栏主题：跟随系统 / 浅色 / 深色，选择存在 localStorage 便于首屏同步应用
export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "helm.theme";

export function readThemeMode(): ThemeMode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const resolved = resolvedTheme(mode);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存储不可用时本次会话内仍然生效，只是刷新后回落到跟随系统
  }
}
