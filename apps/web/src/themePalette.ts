export type Theme = "light" | "dark";
export type Palette = {
  background: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
};
export const presets = [
  {
    id: "oled",
    name: "OLED",
    background: "#000000",
    surface: "#050505",
    text: "#f2f5f4",
    muted: "#b8bfbd",
    accent: "#b1e5c0",
  },
  {
    id: "dark",
    name: "Тёмная",
    background: "#141414",
    surface: "#050505",
    text: "#f0f0f0",
    muted: "#b8b8b8",
    accent: "#8bd5a4",
  },
  {
    id: "light",
    name: "Светлая",
    background: "#f5f7f5",
    surface: "#ffffff",
    text: "#18231c",
    muted: "#4d5b52",
    accent: "#166534",
  },
  {
    id: "pearl",
    name: "Жемчужная",
    background: "#f4f0e9",
    surface: "#fffcf7",
    text: "#2b2925",
    muted: "#635b51",
    accent: "#7a4b19",
  },
  {
    id: "blue",
    name: "Синяя",
    background: "#0b1220",
    surface: "#121e32",
    text: "#e8f0ff",
    muted: "#acbcd6",
    accent: "#9fc5ff",
  },
  {
    id: "amber",
    name: "Янтарная",
    background: "#171109",
    surface: "#241b0f",
    text: "#fff3df",
    muted: "#cfb99a",
    accent: "#ffd27e",
  },
  {
    id: "slate",
    name: "Сланцевая",
    background: "#17191d",
    surface: "#23262d",
    text: "#edf0f5",
    muted: "#b5bfce",
    accent: "#a8b6dc",
  },
] as const;
export function luminance(hex: string) {
  const rgb = hex
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrast(a: string, b: string) {
  return (
    (Math.max(luminance(a), luminance(b)) + 0.05) /
    (Math.min(luminance(a), luminance(b)) + 0.05)
  );
}
export function validPalette(value: unknown): value is Palette {
  if (!value || typeof value !== "object") return false;
  const p = value as Palette;
  return (
    [p.background, p.surface, p.text, p.muted, p.accent].every(
      (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v),
    ) &&
    [p.background, p.surface].every((bg) =>
      [p.text, p.muted, p.accent].every((fg) => contrast(bg, fg) >= 4.5),
    )
  );
}

export type ThemePreference = { preset: string; custom: Palette };
export const defaultPreference: ThemePreference = {
  preset: "dark",
  custom: {
    background: presets[1].background,
    surface: presets[1].surface,
    text: presets[1].text,
    muted: presets[1].muted,
    accent: presets[1].accent,
  },
};
export function parsePreference(raw: string | null): ThemePreference | null {
  if (raw === null || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      !validPalette(value.custom) ||
      (value.preset !== "custom" && !presets.some((p) => p.id === value.preset))
    )
      return null;
    const p = value.custom;
    return {
      preset: value.preset,
      custom: {
        background: p.background,
        surface: p.surface,
        text: p.text,
        muted: p.muted,
        accent: p.accent,
      },
    };
  } catch {
    return null;
  }
}
export function preferenceFromStorage(
  appearance: string | null,
  legacy: string | null,
): ThemePreference {
  return (
    parsePreference(appearance) ?? {
      ...defaultPreference,
      preset: legacy === "light" ? "light" : "dark",
    }
  );
}
