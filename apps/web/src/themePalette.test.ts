// @ts-nocheck -- Native Node test runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  presets,
  validPalette,
  contrast,
  parsePreference,
  preferenceFromStorage,
} from "./themePalette.ts";
test("seven distinct palettes meet AA text and focus contrast on every solid surface", () => {
  assert.equal(presets.length, 7);
  assert.equal(new Set(presets.map((p) => p.background)).size, 7);
  assert.equal(presets.find((p) => p.id === "oled")!.background, "#000000");
  for (const p of presets) {
    assert.equal(validPalette(p), true, p.id);
    for (const bg of [p.background, p.surface])
      for (const fg of [p.text, p.muted, p.accent])
        assert.ok(contrast(bg, fg) >= 4.5, `${p.id}: ${fg} / ${bg}`);
    const onAccent =
      contrast(p.accent, "#000000") >= contrast(p.accent, "#ffffff")
        ? "#000000"
        : "#ffffff";
    assert.ok(contrast(p.accent, onAccent) >= 4.5);
  }
});
test("custom palette rejects low contrast and CSS injection", () => {
  assert.equal(validPalette({ ...presets[0], text: "#010101" }), false);
  assert.equal(
    validPalette({ ...presets[0], accent: "url(https://example.invalid)" }),
    false,
  );
  assert.equal(validPalette({ ...presets[0], background: "#000" }), false);
  assert.equal(validPalette(null), false);
  assert.equal(validPalette({ ...presets[0], muted: "#111111" }), false);
});

test("default dark palette keeps neutral reference panels while OLED retains black background", () => {
  const dark = presets.find((p) => p.id === "dark")!;
  assert.equal(dark.background, "#141414");
  assert.equal(dark.surface, "#050505");
  assert.equal(dark.text, "#f0f0f0");
  assert.equal(dark.muted, "#b8b8b8");
  assert.equal(presets.find((p) => p.id === "oled")!.background, "#000000");
});

test("stored theme preferences validate unknown input and migrate legacy mode without arbitrary CSS", () => {
  assert.equal(preferenceFromStorage(null, "light").preset, "light");
  assert.equal(preferenceFromStorage("broken", "dark").preset, "dark");
  for (const preset of [...presets.map((p) => p.id), "custom"]) {
    const parsed = parsePreference(
      JSON.stringify({ preset, custom: presets[0] }),
    );
    assert.equal(parsed?.preset, preset);
    assert.deepEqual(Object.keys(parsed!.custom).sort(), [
      "accent",
      "background",
      "muted",
      "surface",
      "text",
    ]);
  }
  assert.equal(
    parsePreference(JSON.stringify({ preset: "unknown", custom: presets[0] })),
    null,
  );
  assert.equal(
    parsePreference(
      JSON.stringify({
        preset: "custom",
        custom: { ...presets[0], text: "#000000" },
      }),
    ),
    null,
  );
  assert.equal(parsePreference(" ".repeat(4097)), null);
  assert.equal(parsePreference("null"), null);
});

test("fresh and corrupt storage defaults to OLED while explicit choices survive", () => {
  assert.equal(preferenceFromStorage(null, null).preset, "oled");
  assert.equal(preferenceFromStorage("broken", null).preset, "oled");
  assert.equal(preferenceFromStorage(null, "dark").preset, "dark");
  assert.equal(preferenceFromStorage(null, "light").preset, "light");
});
