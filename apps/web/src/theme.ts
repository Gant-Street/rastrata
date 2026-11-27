export type Theme = "light" | "dark" | "system";

const storageKey = "rastrata-theme";

/** The saved choice, or "system" so the app follows the operating system by default. */
export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Private windows and blocked site data fall through to the default.
  }
  return "system";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The choice still applies for this visit.
  }
}
