import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import "./theme-presets.css";
import "./productPolish.css";
import {
  presets,
  validPalette,
  luminance,
  contrast,
  defaultPreference,
  parsePreference,
  preferenceFromStorage,
} from "./themePalette";
import type { Theme, Palette, ThemePreference } from "./themePalette";
export { presets, validPalette, luminance, contrast } from "./themePalette";
export type { Theme, Palette } from "./themePalette";
const appearanceKey = "java-blueprints:appearance",
  legacyKey = "java-blueprints:theme";
function readPreference(): ThemePreference {
  try {
    return preferenceFromStorage(
      localStorage.getItem(appearanceKey),
      localStorage.getItem(legacyKey),
    );
  } catch {
    return defaultPreference;
  }
}
const ThemeContext = createContext({
  theme: "dark" as Theme,
  preset: "oled",
  palette: defaultPreference.custom,
  setPreset: (_id: string) => {},
  setCustom: (_p: Palette): boolean => false,
  toggle: () => {},
});
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(readPreference);
  const current = useRef(preference);
  const palette =
    preference.preset === "custom"
      ? preference.custom
      : presets.find((p) => p.id === preference.preset)!;
  const theme: Theme = luminance(palette.background) > 0.4 ? "light" : "dark";
  function commit(next: ThemePreference) {
    current.current = next;
    setPreference(next);
    try {
      const json = JSON.stringify(next);
      if (localStorage.getItem(appearanceKey) !== json)
        localStorage.setItem(appearanceKey, json);
      const selected =
        next.preset === "custom"
          ? next.custom
          : presets.find((p) => p.id === next.preset)!;
      const base = luminance(selected.background) > 0.4 ? "light" : "dark";
      if (localStorage.getItem(legacyKey) !== base)
        localStorage.setItem(legacyKey, base);
    } catch {}
  }
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return;
      let next: ThemePreference | null = null;
      if (event.key === appearanceKey) {
        next =
          event.newValue === null
            ? readPreference()
            : parsePreference(event.newValue);
      } else if (event.key === null) {
        next = readPreference();
      } else if (event.key === legacyKey) {
        try {
          if (localStorage.getItem(appearanceKey) !== null) return;
        } catch {
          return;
        }
        if (
          event.newValue !== null &&
          event.newValue !== "light" &&
          event.newValue !== "dark"
        )
          return;
        next = readPreference();
      }
      if (next && JSON.stringify(next) !== JSON.stringify(current.current)) {
        current.current = next;
        setPreference(next);
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreset = preference.preset;
    root.style.colorScheme = theme;
    for (const key of [
      "background",
      "surface",
      "text",
      "muted",
      "accent",
    ] as const)
      root.style.setProperty("--theme-" + key, palette[key]);
    root.style.setProperty(
      "--theme-on-accent",
      contrast(palette.accent, "#000000") >= contrast(palette.accent, "#ffffff")
        ? "#000000"
        : "#ffffff",
    );
  }, [preference, palette, theme]);
  return (
    <ThemeContext.Provider
      value={{
        theme,
        preset: preference.preset,
        palette,
        setPreset: (id) => {
          if (presets.some((p) => p.id === id) || id === "custom")
            commit({ ...current.current, preset: id });
        },
        setCustom: (p) => {
          if (!validPalette(p)) return false;
          const parsed = parsePreference(
            JSON.stringify({ preset: "custom", custom: p }),
          );
          if (!parsed) return false;
          commit(parsed);
          return true;
        },
        toggle: () =>
          commit({
            ...current.current,
            preset: theme === "light" ? "dark" : "light",
          }),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
export function ThemeToggle() {
  const { toggle } = useTheme();
  return <button onClick={toggle}>Переключить тему</button>;
}
