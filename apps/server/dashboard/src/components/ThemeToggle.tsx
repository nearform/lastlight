import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../hooks/useTheme";

/**
 * The theme control — one component, because there are two call sites and they
 * drifted the moment the preference stopped being a boolean (issue #331).
 *
 * `StatsHeader` and `Login` each used to draw their own button from `isDark`.
 * That works for two states and silently breaks at three: `isDark` cannot tell
 * "dark because you asked" from "dark because your OS is", so a `system`
 * preference on a dark OS showed a Moon and a "switch to light" tooltip, while
 * the click actually advanced to `dark` — same resolved theme, nothing visibly
 * moved, and the user had to click twice to reach the theme the tooltip named.
 * A `light` preference on a light OS had the mirror problem.
 *
 * So the icon comes from the PREFERENCE, never from the resolved theme.
 */
const ICON: Record<ThemePreference, typeof Monitor> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

/**
 * What the click will do NEXT, not what the state is.
 *
 * A cycling control whose tooltip described its current state would leave the
 * third state undiscoverable — nothing would ever tell you "system" was on
 * offer.
 */
const TITLE: Record<ThemePreference, string> = {
  system: "Theme: following the system — switch to dark",
  dark: "Theme: dark — switch to light",
  light: "Theme: light — follow the system",
};

export function ThemeToggle({ className }: { className?: string }) {
  const { preference, toggleTheme } = useTheme();
  const Icon = ICON[preference];

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={
        className ??
        "btn btn-ghost btn-xs h-7 min-h-0 px-2 text-base-content/50 hover:text-base-content"
      }
      title={TITLE[preference]}
      aria-label={TITLE[preference]}
    >
      <Icon size={14} />
    </button>
  );
}
