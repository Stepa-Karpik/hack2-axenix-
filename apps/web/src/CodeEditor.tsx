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
    "editor.background": "#00000000",
    "editor.foreground": "#D5D9E0",
    "editor.lineHighlightBackground": "#ffffff04",
    "editorLineNumber.foreground": "#707672",
    "editor.selectionBackground": "#3B4A2D",
    "editorCursor.foreground": "#C8ED83",
  },
});
export function disposeEditorModels(paths: string[]) {
  for (const path of paths)
    monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
}
export default function CodeEditor({
  value,
  path,
  modelPath,
  language = "java",
  onChange,
  range,
  diagnostics,
  onOffset,
  readOnly = false,
  onReady,
}: {
  value: string;
  path: string;
  modelPath?: string;
  language?: string;
  onChange: (text: string) => void;
  range?: SourceRange | null;
  diagnostics: Diagnostic[];
  onOffset: (offset: number) => void;
  readOnly?: boolean;
  onReady?: (commands: {
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
  }) => void;
}) {
  const { theme } = useTheme();
  const viewPath = useRef(path);
  viewPath.current = path;
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
      model.uri.toString() !== monaco.Uri.parse(modelPath ?? path).toString()
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
  }, [range, path, modelPath]);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model)
      monaco.editor.setModelMarkers(
        model,
        "java-blueprints",
        diagnostics
          .filter(
            (d) =>
              d.sourceRange?.filePath === path &&
              d.code !== "UNSUPPORTED_CONTROL_FLOW",
          )
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
      loading={<span className="quiet">Загрузка редактора…</span>}
      path={modelPath ?? path}
      keepCurrentModel
      saveViewState
      language={language}
      theme={theme === "dark" ? "blueprints-dark" : "blueprints-light"}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      options={{
        readOnly,
        editContext: false,
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Consolas', monospace",
        lineHeight: 21,
        minimap: { enabled: false },
        stickyScroll: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 10, bottom: 10 },
        automaticLayout: true,
        tabSize: 4,
        renderLineHighlight: "line",
        overviewRulerBorder: false,
        fixedOverflowWidgets: true,
      }}
      onMount={(instance) => {
        editor.current = instance;
        onReady?.({
          undo: () => {
            instance.focus();
            instance.trigger("menu", "undo", null);
          },
          redo: () => {
            instance.focus();
            instance.trigger("menu", "redo", null);
          },
          selectAll: () => {
            instance.focus();
            instance.trigger("menu", "editor.action.selectAll", null);
          },
        });
        const dom = instance.getDomNode();
        const paste = (event: ClipboardEvent) => {
          if (!instance.hasTextFocus()) return;
          const text = event.clipboardData?.getData("text/plain");
          if (!text || instance.getOption(monaco.editor.EditorOption.readOnly))
            return;
          const selections = instance.getSelections();
          if (!selections || selections.length !== 1) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          instance.pushUndoStop();
          instance.executeEdits("clipboard", [
            {
              range: selections[0],
              text: text.replace(/\r\n?/g, "\n"),
              forceMoveMarkers: true,
            },
          ]);
          instance.pushUndoStop();
        };
        dom?.addEventListener("paste", paste, true);
        instance.onDidDispose(() =>
          dom?.removeEventListener("paste", paste, true),
        );
        decorations.current = instance.createDecorationsCollection();
        instance.onDidChangeModel(() => highlight.current());
        try {
          const view = JSON.parse(
            localStorage.getItem(
              "java-blueprints:editor-view:" + viewPath.current,
            ) ?? "null",
          );
          if (view) instance.restoreViewState(view);
        } catch {}
        let saveTimer: ReturnType<typeof setTimeout>;
        const saveView = () => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const key = viewPath.current;
            if (key)
              try {
                localStorage.setItem(
                  "java-blueprints:editor-view:" + key,
                  JSON.stringify(instance.saveViewState()),
                );
              } catch {}
          }, 180);
        };
        const flushView = () => {
          try {
            localStorage.setItem(
              "java-blueprints:editor-view:" + viewPath.current,
              JSON.stringify(instance.saveViewState()),
            );
          } catch {}
        };
        window.addEventListener("pagehide", flushView);
        const scrollListener = instance.onDidScrollChange(saveView);
        const cursorListener = instance.onDidChangeCursorPosition(saveView);
        instance.onDidDispose(() => {
          clearTimeout(saveTimer);
          window.removeEventListener("pagehide", flushView);
          scrollListener.dispose();
          cursorListener.dispose();
        });
        highlight.current();
        instance.onDidChangeCursorPosition((e) => {
          // Restoring a model or its caret must not change the selected method.
          if (e.source !== "keyboard" && e.source !== "mouse") return;
          const model = instance.getModel();
          if (model) onOffsetRef.current(model.getOffsetAt(e.position));
        });
      }}
    />
  );
}
