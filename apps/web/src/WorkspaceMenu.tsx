import { useEffect, useRef } from "react";
import TourButton from "./TourButton";
import type { ReactNode } from "react";
import { panelIds, panelLabels, visiblePanels } from "./workspaceLayout";
import type { WorkspaceController } from "./Workspace";
export default function WorkspaceMenu({
  workspace: w,
  actions,
  archiveItems,
}: {
  workspace: WorkspaceController;
  archiveItems?: ReactNode;
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
        data-tour={
          label === "Сохранить расположение проекта" ? "save-layout" : undefined
        }
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
        <summary
          data-assistant-menu={label}
          data-tour={label === "Вид" ? "workspace-view" : undefined}
        >
          {label}
        </summary>
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
          {item(
            "Сохранить файл на компьютер",
            actions.save,
            actions.saveDisabled,
            "Ctrl+S",
          )}
          {item("Экспорт версии", actions.export, actions.exportDisabled)}
          {archiveItems}
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
          {panelIds.map((panel) => (
            <button
              type="button"
              key={panel}
              aria-pressed={shown.includes(panel)}
              disabled={panel === "graph"}
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
          {item("Сохранить расположение проекта", () => w.saveLayout())}
          {item("Сделать расположение базовым", () => w.saveLayout(true))}
          {item("Сбросить расположение", () => void w.restoreLayout())}
          {item(
            w.navigationDocked
              ? "Навигация на полотне"
              : "Навигация в верхней панели",
            w.toggleNavigationDock,
          )}
          {w.layoutNotice && (
            <span className="workspace-menu-note" role="status">
              {w.layoutNotice}
            </span>
          )}
        </>,
      )}
      {menu(
        "Справка",
        <>
          <TourButton label="Пройти обучение редактору" mode="context" />
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
