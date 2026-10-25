import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";

// Keep the editor, its languages and workers out of login/profile/project-list startup.
let loaded: Promise<typeof import("./CodeEditor")> | undefined;
const load = () => (loaded ??= import("./CodeEditor"));
const Editor = lazy(load);
export function disposeEditorModels(paths: string[]) {
  // Leaving a page which never needed the editor must not load Monaco just to clean up.
  if (loaded) void loaded.then((module) => module.disposeEditorModels(paths));
}
export default function DeferredCodeEditor(
  props: ComponentProps<typeof import("./CodeEditor").default>,
) {
  return (
    <Suspense
      fallback={
        <span className="quiet" role="status">
          Загрузка редактора…
        </span>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
