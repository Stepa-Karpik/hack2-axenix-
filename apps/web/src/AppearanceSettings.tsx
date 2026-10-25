import { useEffect, useRef, useState } from "react";
import { useAccount } from "./Account";
import { presets, useTheme, validPalette, contrast } from "./theme";
import type { Palette } from "./theme";
export function AppearanceSettings() {
  const { preset, palette, setPreset, setCustom } = useTheme();
  const { session } = useAccount();
  const dirty = useRef(false);
  const [draft, setDraft] = useState<Palette>({ ...palette });
  const [result, setResult] = useState("");
  useEffect(() => {
    if (!dirty.current) setDraft({ ...palette });
  }, [palette]);

  const labels: Record<keyof Palette, string> = {
    background: "Фон",
    surface: "Поверхность",
    text: "Текст",
    muted: "Вторичный текст",
    accent: "Акцент",
  };
  const valid = validPalette(draft);
  return (
    <section className="product-card appearance-settings">
      <h2>Цветовая тема</h2>
      <p className="product-muted">
        Сохраняется в этом браузере. Выберите палитру или настройте свою.
      </p>
      <div className="theme-options">
        {presets.map((p) => (
          <button
            key={p.id}
            aria-pressed={preset === p.id}
            onClick={() => {
              dirty.current = false;
              setPreset(p.id);
              setDraft({ ...p });
              setResult("");
            }}
            className="theme-option"
          >
            <span
              className="theme-preview"
              aria-hidden="true"
              style={{
                background: p.background,
                color: p.text,
                borderColor: p.muted,
              }}
            >
              <span style={{ background: p.surface }}>
                Aa <i style={{ background: p.accent }} />
              </span>
            </span>
            {p.name}
          </button>
        ))}
      </div>
      {session?.user && (
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("java-blueprints:tour"))
          }
        >
          Повторить знакомство
        </button>
      )}
      <h3>Своя палитра</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (setCustom(draft)) {
            dirty.current = false;
            setResult("Своя палитра сохранена.");
          }
        }}
      >
        <div className="custom-colors">
          {(Object.keys(labels) as (keyof Palette)[]).map((key) => (
            <label key={key}>
              {labels[key]}
              <input
                aria-label={labels[key]}
                type="color"
                value={draft[key]}
                onChange={(e) => {
                  dirty.current = true;
                  setDraft((p) => ({ ...p, [key]: e.target.value }));
                  setResult("");
                }}
              />
            </label>
          ))}
        </div>
        <p className="product-muted">
          Контраст текста:{" "}
          {Math.min(
            contrast(draft.text, draft.background),
            contrast(draft.text, draft.surface),
          ).toFixed(2)}
          :1. Для всех текстовых цветов требуется минимум 4.5:1.
        </p>
        {!valid && (
          <p role="alert">
            Увеличьте контраст текста, вторичного текста и акцента с фоном и
            поверхностью.
          </p>
        )}
        <button className="product-action" disabled={!valid}>
          Применить свою палитру
        </button>
        {result && <p role="status">{result}</p>}
      </form>
    </section>
  );
}
