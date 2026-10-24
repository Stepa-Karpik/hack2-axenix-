import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { panelIds, panelLabels, visiblePanels } from "./workspaceLayout";
import type { WorkspaceController } from "./Workspace";
export default function WorkspaceMenu({
  workspace: w,
  actions,
}: {
  workspace: WorkspaceController;
  actions: {
    save: () => void;
    createFile: () => void;
    createFolder: () => void;
    import: () => void;
    export: () => void;
    projects: () => void;
    run: () => void;
    compare: () => void;
    stop: () => void;
    edit: (command: "undo" | "redo" | "selectAll") => void;
    editDisabled: boolean;
    saveDisabled: boolean;
    runDisabled: boolean;
    exportDisabled: boolean;
    importDisabled: boolean;
    stopDisabled: boolean;
  };
}) {
  const shown = visiblePanels(w.layout);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!bar.current?.contains(event.target as Node))
        bar.current
          ?.querySelectorAll("details[open]")
          .forEach((d) => d.removeAttribute("open"));
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function item(
    label: string,
    action: () => void,
    disabled = false,
    shortcut?: string,
  ) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          action();
          e.currentTarget.closest("details")?.removeAttribute("open");
        }}
      >
        {label}
        {shortcut && <kbd>{shortcut}</kbd>}
      </button>
    );
  }
  function menu(label: string, children: ReactNode) {
    return (
      <details
        className="workspace-menu"
        onToggle={(e) => {
          if (e.currentTarget.open) {
            const current = e.currentTarget;
            current.parentElement
              ?.querySelectorAll("details[open]")
              .forEach((d) => {
                if (d !== current) d.removeAttribute("open");
              });
          }
        }}
      >
        <summary>{label}</summary>
        <div className="workspace-menu-popup">{children}</div>
      </details>
    );
  }
  return (
    <nav
      className="workspace-menubar"
      ref={bar}
      aria-label="Главное меню"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          const open =
            e.currentTarget.querySelector<HTMLDetailsElement>("details[open]");
          if (open) {
            e.preventDefault();
            e.stopPropagation();
            open.removeAttribute("open");
            open.querySelector<HTMLElement>("summary")?.focus();
          }
        }
      }}
    >
      {menu(
        "Файл",
        <>
          {item("Все проекты", actions.projects)}
          {item("Создать файл", actions.createFile, actions.importDisabled)}
          {item("Создать папку", actions.createFolder, actions.importDisabled)}
          {item("Импорт файлов…", actions.import, actions.importDisabled)}
          {item("Сохранить", actions.save, actions.saveDisabled, "Ctrl+S")}
          {item("Экспорт версии", actions.export, actions.exportDisabled)}
        </>,
      )}
      {menu(
        "Правка",
        <>
          {item(
            "Отменить",
            () => actions.edit("undo"),
            actions.editDisabled,
            "Ctrl+Z",
          )}
          {item(
            "Повторить",
            () => actions.edit("redo"),
            actions.editDisabled,
            "Ctrl+Shift+Z",
          )}
          {item(
            "Выделить всё",
            () => actions.edit("selectAll"),
            actions.editDisabled,
            "Ctrl+A",
          )}
        </>,
      )}
      {menu(
        "Вид",
        <>
          {item(
            w.editing ? "Завершить настройку" : "Настроить расположение",
            () => w.setEditing(!w.editing),
          )}
          <hr />
          {panelIds.map((panel) => (
            <button
              type="button"
              key={panel}
              aria-pressed={shown.includes(panel)}
              disabled={shown.length === 1 && shown.includes(panel)}
              onClick={() =>
                shown.includes(panel) ? w.hide(panel) : w.reveal(panel)
              }
            >
              <span>
                {shown.includes(panel) ? "✓" : "+"} {panelLabels[panel]}
              </span>
            </button>
          ))}
          <hr />
          {item("Схема и код", () => w.preset("default"))}
          {item("Работа с кодом", () => w.preset("code"))}
          {item("Проверка изменений", () => w.preset("review"))}
          {item("Сбросить расположение", () => w.preset("default"))}
        </>,
      )}
      {menu(
        "Запуск",
        <>
          {item("Запустить…", actions.run, actions.runDisabled, "Ctrl+Enter")}
          {item(
            "Сравнить версии…",
            actions.compare,
            actions.runDisabled,
            "Ctrl+Shift+Enter",
          )}
          {item("Остановить", actions.stop, actions.stopDisabled)}
        </>,
      )}
      {menu(
        "Справка",
        <>
          <span className="workspace-menu-note">Java Blueprints · Java 21</span>
          <span className="workspace-menu-hint">
            Выберите узел → измените → проверьте diff → примените.
          </span>
          <span className="workspace-menu-hint">
            Запуск и сравнение выполняются в изолированном runner.
          </span>
          <span className="workspace-menu-hint">
            Расположение сохраняется в этом браузере для проекта.
          </span>
        </>,
      )}
    </nav>
  );
}
