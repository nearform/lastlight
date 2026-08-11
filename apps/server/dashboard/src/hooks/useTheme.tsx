import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  DEFAULT_PREFERENCE,
  STORAGE_KEY,
  nextPreference,
  parsePreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from "../lib/theme";

export type { Theme, ThemePreference };

interface ThemeContextValue {
  /** The theme actually applied — always concrete, never "system". */
  theme: Theme;
  /** What the user asked for. `system` means "follow the OS". */
  preference: ThemePreference;
  /** Convenience — true for the dark `lastlight` theme. */
  isDark: boolean;
  setPreference: (p: ThemePreference) => void;
  /** Advance the cycle: system → dark → light → system. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

const systemPrefersDark = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.(DARK_QUERY).matches;

/**
 * The preference the pre-paint script in `index.html` already read.
 *
 * Read from storage rather than from the `data-theme` attribute it set: the
 * attribute is the RESOLVED theme, and `lastlight` there is ambiguous — it
 * could be an explicit dark choice or a `system` preference on a dark OS.
 * Collapsing those two would silently convert everyone following the OS into
 * a pinned preference on first render, which is the bug this replaces.
 */
function storedPreference(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveTheme(storedPreference(), systemPrefersDark()),
  );

  const apply = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    setThemeState(t);
  }, []);

  const setPreference = useCallback(
    (p: ThemePreference) => {
      setPreferenceState(p);
      apply(resolveTheme(p, systemPrefersDark()));
      try {
        localStorage.setItem(STORAGE_KEY, p);
      } catch {
        // Private-mode / storage-disabled — the theme still applies for this
        // session, it just won't survive a reload.
      }
    },
    [apply],
  );

  /**
   * Track the OS while the preference is `system`.
   *
   * Without this, "follow the OS" would mean "follow the OS as it was when the
   * tab loaded" — a machine that switches at sunset would leave the dashboard
   * on the wrong theme until a reload. The listener is only attached for
   * `system`, so an explicit choice costs nothing and cannot be overridden.
   */
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia?.(DARK_QUERY);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => apply(resolveTheme("system", e.matches));
    mq.addEventListener("change", onChange);
    // Re-resolve on attach too: the OS may have changed between the pre-paint
    // script running and this effect, and while another tab held the mount.
    apply(resolveTheme("system", mq.matches));
    return () => mq.removeEventListener("change", onChange);
  }, [preference, apply]);

  const toggleTheme = useCallback(() => {
    setPreference(nextPreference(preference));
  }, [preference, setPreference]);

  return (
    <ThemeContext.Provider
      value={{ theme, preference, isDark: theme === "lastlight", setPreference, toggleTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
