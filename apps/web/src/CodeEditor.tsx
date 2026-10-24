import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import type { Diagnostic, SourceRange } from "./types";
import { useTheme } from "./theme";
// All Monaco assets and workers are bundled by Vite; no CDN is used.
globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("blueprints", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8b9188" },
    { token: "keyword", foreground: "687d38" },
    { token: "string", foreground: "9b6d45" },
  ],
  colors: {
    "editor.background": "#fbfcf9",
    "editor.lineHighlightBackground": "#f0f3e9",
    "editorLineNumber.foreground": "#b0b6aa",
    "editor.selectionBackground": "#dce6bd",
    "editorCursor.foreground": "#394832",
  },
});
monaco.editor.defineTheme("blueprints-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8A9099" },
    { token: "keyword", foreground: "6760A5" },
    { token: "string", foreground: "678A36" },
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#282B33",
    "editor.lineHighlightBackground": "#F5F6F8",
    "editorLineNumber.foreground": "#B0B5BF",
    "editor.selectionBackground": "#DDE9C5",
    "editorCursor.foreground": "#303B24",
  },
});
monaco.editor.defineTheme("blueprints-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "79818E" },
    { token: "keyword", foreground: "BAA9EA" },
    { token: "string", foreground: "B9D58D" },
  ],
  colors: {
    "editor.background": "#1B1D22",
    "editor.foreground": "#D5D9E0",
    "editor.lineHighlightBackground": "#24272F",
    "editorLineNumber.foreground": "#626A78",
    "editor.selectionBackground": "#3B4A2D",
    "editorCursor.foreground": "#C8ED83",
  },
});
export default function CodeEditor({
  value,
  path,
  onChange,
  range,
  diagnostics,
  onOffset,
  readOnly = false,
}: {
  value: string;
  path: string;
  onChange: (text: string) => void;
  range?: SourceRange | null;
  diagnostics: Diagnostic[];
  onOffset: (offset: number) => void;
  readOnly?: boolean;
}) {
  const { theme } = useTheme();
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(
    null,
  );
  const onOffsetRef = useRef(onOffset);
  onOffsetRef.current = onOffset;
  const highlight = useRef(() => {});
  highlight.current = () => {
    decorations.current?.clear();
    const model = editor.current?.getModel();
    if (
      !editor.current ||
      !model ||
      !range ||
      range.filePath !== path ||
      model.uri.toString() !== monaco.Uri.parse(path).toString()
    )
      return;
    const r = new monaco.Range(
      range.startLine,
      range.startColumn,
      range.endLine,
      range.endColumn,
    );
    editor.current.revealRangeInCenterIfOutsideViewport(r);
    decorations.current?.set([
      { range: r, options: { isWholeLine: false, className: "code-binding" } },
    ]);
  };
  useEffect(() => {
    highlight.current();
  }, [range, path]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model)
      monaco.editor.setModelMarkers(
        model,
        "java-blueprints",
        diagnostics
          .filter((d) => d.sourceRange?.filePath === path)
          .map((d) => ({
            message: d.message,
            severity:
              d.severity === "error"
                ? monaco.MarkerSeverity.Error
                : monaco.MarkerSeverity.Warning,
            startLineNumber: d.sourceRange!.startLine,
            startColumn: d.sourceRange!.startColumn,
            endLineNumber: d.sourceRange!.endLine,
            endColumn: d.sourceRange!.endColumn,
          })),
      );
  }, [diagnostics, path, value]);
  return (
    <Editor
      height="100%"
      path={path}
      language="java"
      theme={theme === "dark" ? "blueprints-dark" : "blueprints-light"}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Consolas', monospace",
        lineHeight: 22,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 22, bottom: 22 },
        automaticLayout: true,
        tabSize: 4,
        renderLineHighlight: "line",
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
      }}
      onMount={(instance) => {
        editor.current = instance;
        decorations.current = instance.createDecorationsCollection();
        instance.onDidChangeModel(() => highlight.current());
        highlight.current();
        instance.onDidChangeCursorPosition((e) => {
          const model = instance.getModel();
          if (model) onOffsetRef.current(model.getOffsetAt(e.position));
        });
      }}
    />
  );
}
