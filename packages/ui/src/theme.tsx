import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  THEME_LABELS,
  THEME_TOKENS,
  isThemePreference,
  resolveTheme,
  type Theme,
  type ThemePreference,
} from "./tokens.js";
const ThemeContext = createContext<{
  preference: ThemePreference;
  theme: Theme;
  choose: (p: ThemePreference) => void;
} | null>(null);
/** Per-window presentation only. No storage, broadcast, cookies, network calls or authority changes. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, choose] = useState<ThemePreference>("system");
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(query.matches);
    changed();
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const theme = resolveTheme(preference, systemDark);
  const style: CSSProperties = {
    colorScheme: theme === "light" ? "light" : "dark",
    ...Object.fromEntries(
      Object.entries(THEME_TOKENS[theme]).map(([name, value]) => [
        "--zt-" + name,
        value,
      ]),
    ),
  };
  return (
    <ThemeContext.Provider value={{ preference, theme, choose }}>
      <div className="zt-theme" data-zt-theme={theme} style={style}>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("ThemeProvider is required");
  return context;
}
export function ThemeSelect() {
  const { preference, choose } = useTheme();
  const id = useId();
  return (
    <label className="zt-theme-select" htmlFor={id}>
      外观
      <select
        id={id}
        value={preference}
        onChange={(event) => {
          if (isThemePreference(event.target.value)) choose(event.target.value);
        }}
      >
        {Object.entries(THEME_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
