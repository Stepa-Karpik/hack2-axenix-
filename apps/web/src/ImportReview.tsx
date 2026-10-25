import { useState } from "react";
export interface ImportTree {
  files: { path: string; content: string }[];
  directories: string[];
  provenance?: Record<string, unknown>;
}
export default function ImportReview({
  preview,
  busy,
  locked = false,
  onConfirm,
  onBack,
}: {
  preview: ImportTree;
  busy: boolean;
  locked?: boolean;
  onConfirm: (tree: ImportTree) => void;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState(
    () =>
      new Set([...preview.files.map((f) => f.path), ...preview.directories]),
  );
  const [opened, setOpened] = useState(preview.files[0]?.path ?? "");
  const paths = [
    ...new Set([...preview.files.map((f) => f.path), ...preview.directories]),
  ].sort();
  return (
    <section className="source-import-review" aria-label="Предпросмотр импорта">
      <h3>Исходники перед импортом</h3>
      {preview.provenance?.commitSha != null && (
        <p className="small quiet">
          Commit <code>{String(preview.provenance.commitSha)}</code>
        </p>
      )}
      <div className="import-preview-source">
        {paths.map((path) => (
          <label key={path}>
            <input
              type="checkbox"
              checked={selected.has(path)}
              disabled={busy || locked}
              onChange={(e) => {
                const subtree = paths.filter(
                  (p) => p === path || p.startsWith(path + "/"),
                );
                setSelected((old) => {
                  const next = new Set(old);
                  subtree.forEach((p) =>
                    e.target.checked ? next.add(p) : next.delete(p),
                  );
                  return next;
                });
              }}
            />
            <button type="button" onClick={() => setOpened(path)}>
              {path}
              {preview.directories.includes(path) ? "/" : ""}
            </button>
          </label>
        ))}
      </div>
      {preview.files.find((f) => f.path === opened) && (
        <details>
          <summary>{opened}</summary>
          <pre className="import-preview-source">
            {preview.files.find((f) => f.path === opened)?.content}
          </pre>
        </details>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onBack}>
          Назад
        </button>
        <button
          className="primary"
          disabled={busy || !selected.size}
          onClick={() =>
            onConfirm({
              ...preview,
              files: preview.files.filter((f) => selected.has(f.path)),
              directories: preview.directories.filter((p) => selected.has(p)),
            })
          }
        >
          {busy ? "Создание…" : "Создать проект из выбранного"}
        </button>
      </div>
    </section>
  );
}
