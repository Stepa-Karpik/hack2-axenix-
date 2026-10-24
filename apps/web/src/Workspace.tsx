import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  defaultLayout,
  groups,
  hidePanel,
  layoutKey,
  movePanel,
  panelIds,
  panelLabels,
  readLayout,
  resizeSplit,
  revealPanel,
  visiblePanels,
} from "./workspaceLayout";
import type {
  DropEdge,
  Group,
  LayoutNode,
  PanelId,
  WorkspaceLayout,
} from "./workspaceLayout";
export function useWorkspace(projectId: string) {
  const [layout, setLayout] = useState(() => readLayout(projectId));
  const [editing, setEditing] = useState(false);
  const [maximized, setMaximized] = useState<PanelId | null>(null);
  const [focused, setFocused] = useState<PanelId>("graph");
  const transition = useRef<{ skipTransition: () => void } | null>(null);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      transition.current?.skipTransition();
    };
  }, []);
  function animate(change: () => void): Promise<void> {
    // Serialize state updates, not animation completion. Skipping a snapshot does
    // not cancel its pending callback, so the next callback waits for that update.
    const run = () => {
      if (!alive.current) return Promise.resolve();
      transition.current?.skipTransition();
      if (
        document.startViewTransition &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const current = document.startViewTransition(() => {
          if (alive.current) flushSync(change);
        });
        transition.current = current;
        void current.ready.catch(() => {});
        void current.finished
          .catch(() => {})
          .finally(() => {
            if (transition.current === current) transition.current = null;
          });
        return current.updateCallbackDone;
      }
      flushSync(change);
      return Promise.resolve();
    };
    const completion = pending.current.then(run, run);
    pending.current = completion.catch(() => {});
    return completion;
  }
  useEffect(() => {
    try {
      localStorage.setItem(layoutKey(projectId), JSON.stringify(layout));
    } catch {}
  }, [layout, projectId]);
  return {
    layout,
    setLayout,
    animateLayout: (update: (layout: WorkspaceLayout) => WorkspaceLayout) =>
      animate(() => setLayout(update)),
    maximize: (panel: PanelId | null) => animate(() => setMaximized(panel)),
    editing,
    setEditing,
    maximized,
    setMaximized,
    focused,
    setFocused,
    reveal: (panel: PanelId) =>
      animate(() => {
        setLayout((l) => revealPanel(l, panel));
        setFocused(panel);
        setMaximized((m) => (m && m !== panel ? null : m));
      }),
    revealMany: (panels: PanelId[]) =>
      animate(() => {
        setLayout((l) =>
          panels.reduce((next, panel) => revealPanel(next, panel), l),
        );
        if (panels.length) setFocused(panels[panels.length - 1]);
        setMaximized((m) => (m && !panels.includes(m) ? null : m));
      }),
    hide: (panel: PanelId) =>
      animate(() => {
        setLayout((l) => hidePanel(l, panel));
        setMaximized((m) => (m === panel ? null : m));
      }),
    preset: (preset: "default" | "code" | "review") =>
      animate(() => {
        setLayout(defaultLayout(preset));
        setMaximized(null);
      }),
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;
export default function Workspace({
  controller: c,
  panels,
}: {
  controller: WorkspaceController;
  panels: Record<PanelId, ReactNode>;
}) {
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 980px)").matches,
  );
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const storage = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  // These DOM hosts and their portals never change identity when a layout slot moves.
  const [hosts] = useState(
    () =>
      Object.fromEntries(
        panelIds.map((id) => [
          id,
          (() => {
            const host = document.createElement("div");
            host.className = "workspace-panel-host";
            host.dataset.panelId = id;
            host.style.viewTransitionName = "workspace-" + id;
            return host;
          })(),
        ]),
      ) as Record<PanelId, HTMLDivElement>,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 980px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!c.editing) {
      setDragging(null);
      setOver(null);
    }
  }, [c.editing]);
  useEffect(() => {
    for (const panel of panelIds)
      if (!hosts[panel].isConnected && storage.current) {
        hosts[panel].inert = true;
        storage.current.appendChild(hosts[panel]);
      }
  });
  function mount(panel: PanelId, slot: HTMLDivElement | null) {
    const host = hosts[panel];
    host.className = "workspace-panel-host";
    host.dataset.panelId = panel;
    if (slot) {
      host.inert = false;
      slot.appendChild(host);
    } else if (storage.current) {
      host.inert = true;
      storage.current.appendChild(host);
    }
  }
  const mountCallbacks = useMemo(
    () =>
      Object.fromEntries(
        panelIds.map((panel) => [
          panel,
          (slot: HTMLDivElement | null) => mount(panel, slot),
        ]),
      ) as Record<PanelId, (slot: HTMLDivElement | null) => void>,
    [hosts],
  );
  function canSplit(targetId: string, edge: DropEdge) {
    if (["center", "tabs"].includes(edge)) return true;
    const slot = document.querySelector('[data-group-id="' + targetId + '"]');
    const size = slot?.getBoundingClientRect();
    return (
      !!size &&
      (["left", "right"].includes(edge)
        ? size.width >= 320
        : size.height >= 220)
    );
  }
  function move(panel: PanelId, targetId: string, edge: DropEdge) {
    if (canSplit(targetId, edge))
      c.animateLayout((l) => movePanel(l, panel, targetId, edge));
    else
      setMoveNotice(
        "Для разделения увеличьте панель или выберите объединение вкладок.",
      );
  }
  const [moveNotice, setMoveNotice] = useState("");
  function target(group: Group, edge: Exclude<DropEdge, "tabs">) {
    return (
      <div
        key={edge}
        className={
          "workspace-drop-zone drop-" +
          edge +
          (over === group.id + edge ? " over" : "")
        }
        data-drop-zone={edge}
        aria-label={panelLabels[group.active] + ": " + edge}
        onDragOver={(e) => {
          if (dragging) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setOver(group.id + edge);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragging) move(dragging, group.id, edge);
          setDragging(null);
          setOver(null);
        }}
      >
        {edge === "center"
          ? "Поменять местами"
          : { left: "Слева", right: "Справа", top: "Сверху", bottom: "Снизу" }[
              edge
            ]}
      </div>
    );
  }
  function renderGroup(group: Group) {
    return (
      <section
        className="workspace-group"
        data-group-id={group.id}
        key={group.id}
        aria-label={panelLabels[group.active]}
      >
        <header
          className="workspace-panel-header"
          data-panel-header={group.active}
          data-drop-zone="tabs"
          onDragOver={(e) => {
            if (dragging) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(group.id + "tabs");
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragging) move(dragging, group.id, "tabs");
            setDragging(null);
            setOver(null);
          }}
        >
          <div
            className="workspace-panel-tabs"
            role="tablist"
            aria-label="Панели"
          >
            {group.tabs.map((panel) => (
              <button
                key={panel}
                type="button"
                role="tab"
                aria-selected={group.active === panel}
                className={group.active === panel ? "active" : ""}
                draggable={c.editing}
                data-panel-tab={panel}
                onDragStart={(e) => {
                  setDragging(panel);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", panel);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onClick={() => c.reveal(panel)}
                title={
                  c.editing
                    ? "Перетащите панель за заголовок"
                    : panelLabels[panel]
                }
              >
                {c.editing && <span aria-hidden="true">⠿</span>}
                {panelLabels[panel]}
              </button>
            ))}
          </div>
          {c.editing && (
            <MovePanelMenu
              panel={group.active}
              layout={c.layout}
              onMove={(targetId, edge) => move(group.active, targetId, edge)}
            />
          )}
          <button
            className="workspace-panel-action"
            aria-label={
              c.maximized === group.active
                ? "Восстановить панель"
                : "Развернуть " + panelLabels[group.active]
            }
            title="Развернуть панель"
            onClick={() =>
              c.maximize(c.maximized === group.active ? null : group.active)
            }
          >
            {c.maximized === group.active ? "↙" : "↗"}
          </button>
          <button
            className="workspace-panel-action"
            aria-label={"Скрыть " + panelLabels[group.active]}
            title="Скрыть панель"
            disabled={visiblePanels(c.layout).length === 1}
            onClick={() => c.hide(group.active)}
          >
            ×
          </button>
        </header>
        <div
          className="workspace-panel-slot"
          ref={mountCallbacks[group.active]}
        />
        {dragging && (
          <div className="workspace-drop-targets">
            {(["left", "right", "top", "bottom", "center"] as const).map(
              (edge) => target(group, edge),
            )}
          </div>
        )}
      </section>
    );
  }
  function render(node: LayoutNode): ReactNode {
    if (node.type === "group") return renderGroup(node);
    return (
      <div className={"workspace-split axis-" + node.axis} key={node.id}>
        <div className="workspace-branch" style={{ flex: node.ratio }}>
          {render(node.first)}
        </div>
        <WorkspaceSeparator
          node={node}
          onChange={(ratio) =>
            c.setLayout((l) => resizeSplit(l, node.id, ratio))
          }
        />
        <div className="workspace-branch" style={{ flex: 1 - node.ratio }}>
          {render(node.second)}
        </div>
      </div>
    );
  }
  const shown = visiblePanels(c.layout);
  const focus = shown.includes(c.focused) ? c.focused : shown[0];
  const compact =
    narrow ||
    (size.width > 0 &&
      !fitsLayout(c.layout.root, size.width, Math.max(1, size.height - 40)));
  const solo = c.maximized ?? (compact ? focus : null);
  const soloGroup = solo
    ? { type: "group" as const, id: "focused", tabs: [solo], active: solo }
    : null;
  return (
    <div
      className={"configurable-workspace" + (c.editing ? " is-editing" : "")}
      ref={container}
    >
      {compact && (
        <nav className="workspace-mobile-panels" aria-label="Выбрать панель">
          <select
            aria-label="Открытая панель"
            value={solo ?? focus}
            onChange={(e) => c.reveal(e.target.value as PanelId)}
          >
            {panelIds.map((panel) => (
              <option key={panel} value={panel}>
                {panelLabels[panel]}
              </option>
            ))}
          </select>
          <button onClick={() => c.preset("default")}>Сбросить вид</button>
        </nav>
      )}
      {c.editing && !compact && (
        <div className="workspace-edit-hint">
          Перетащите заголовок: центр — обмен, край — разделить, заголовок —
          вкладки. <button onClick={() => c.setEditing(false)}>Готово</button>
        </div>
      )}
      {moveNotice && (
        <div className="workspace-edit-hint" role="status">
          {moveNotice}
          <button onClick={() => setMoveNotice("")}>Закрыть</button>
        </div>
      )}
      <div className="workspace-layout">
        {soloGroup ? renderGroup(soloGroup) : render(c.layout.root)}
      </div>
      <div hidden inert ref={storage} data-workspace-storage="true" />
      {panelIds.map((panel) =>
        createPortal(panels[panel], hosts[panel], panel),
      )}
    </div>
  );
}
function WorkspaceSeparator({
  node,
  onChange,
}: {
  node: Extract<LayoutNode, { type: "split" }>;
  onChange: (ratio: number) => void;
}) {
  const start = useRef<{ at: number; ratio: number; span: number } | null>(
    null,
  );
  const horizontal = node.axis === "horizontal";
  const element = useRef<HTMLDivElement>(null);
  function bounds() {
    const span =
      (horizontal
        ? element.current?.parentElement?.clientWidth
        : element.current?.parentElement?.clientHeight) ?? 0;
    const available = Math.max(1, span - 7);
    return {
      min: Math.max(0.15, minimumExtent(node.first, node.axis) / available),
      max: Math.min(
        0.85,
        1 - minimumExtent(node.second, node.axis) / available,
      ),
    };
  }
  const [limits, setLimits] = useState({ min: 0.15, max: 0.85 });
  useEffect(() => {
    const parent = element.current?.parentElement;
    const observer = new ResizeObserver(() => {
      const next = bounds();
      setLimits(
        next.min <= next.max ? next : { min: node.ratio, max: node.ratio },
      );
    });
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, [node.first, node.second, node.axis]);
  function resize(ratio: number) {
    const { min, max } = bounds();
    if (min <= max) onChange(Math.max(min, Math.min(max, ratio)));
  }

  return (
    <div
      className="workspace-separator"
      data-split-id={node.id}
      ref={element}
      role="separator"
      tabIndex={0}
      aria-label={horizontal ? "Ширина панелей" : "Высота панелей"}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={limits.min * 100}
      aria-valuemax={limits.max * 100}
      aria-valuenow={node.ratio * 100}
      onPointerDown={(e) => {
        start.current = {
          at: horizontal ? e.clientX : e.clientY,
          ratio: node.ratio,
          span:
            (horizontal
              ? e.currentTarget.parentElement?.clientWidth
              : e.currentTarget.parentElement?.clientHeight) ?? 1,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (start.current)
          resize(
            start.current.ratio +
              ((horizontal ? e.clientX : e.clientY) - start.current.at) /
                start.current.span,
          );
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        const delta = horizontal
          ? e.key === "ArrowLeft"
            ? -0.03
            : e.key === "ArrowRight"
              ? 0.03
              : 0
          : e.key === "ArrowUp"
            ? -0.03
            : e.key === "ArrowDown"
              ? 0.03
              : 0;
        if (delta) {
          e.preventDefault();
          resize(node.ratio + delta);
        }
      }}
    />
  );
}

function MovePanelMenu({
  panel,
  layout,
  onMove,
}: {
  panel: PanelId;
  layout: WorkspaceLayout;
  onMove: (target: string, edge: DropEdge) => void;
}) {
  const destinations = groups(layout.root).filter(
    (g) => !g.tabs.includes(panel),
  );
  const [target, setTarget] = useState("");
  const [edge, setEdge] = useState<DropEdge>("center");
  const selectedTarget = destinations.some((g) => g.id === target)
    ? target
    : (destinations[0]?.id ?? "");
  return (
    <details className="workspace-move-menu">
      <summary
        aria-label={"Переместить " + panelLabels[panel]}
        title="Переместить панель с клавиатуры"
      >
        ⋯
      </summary>
      <div className="workspace-move-popup">
        <label>
          Рядом с панелью
          <select
            aria-label="Панель назначения"
            value={selectedTarget}
            onChange={(e) => setTarget(e.target.value)}
          >
            {destinations.map((g) => (
              <option key={g.id} value={g.id}>
                {panelLabels[g.active]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Расположение
          <select
            aria-label="Способ перемещения"
            value={edge}
            onChange={(e) => setEdge(e.target.value as DropEdge)}
          >
            {(
              ["center", "tabs", "left", "right", "top", "bottom"] as const
            ).map((e) => (
              <option key={e} value={e}>
                {
                  {
                    center: "Поменять местами",
                    tabs: "Объединить вкладки",
                    left: "Слева",
                    right: "Справа",
                    top: "Сверху",
                    bottom: "Снизу",
                  }[e]
                }
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!selectedTarget}
          onClick={(e) => {
            onMove(selectedTarget, edge);
            e.currentTarget.closest("details")?.removeAttribute("open");
          }}
        >
          Переместить
        </button>
      </div>
    </details>
  );
}

function minimumExtent(
  node: LayoutNode,
  axis: "horizontal" | "vertical",
): number {
  if (node.type === "group") return axis === "horizontal" ? 150 : 100;
  const first = minimumExtent(node.first, axis),
    second = minimumExtent(node.second, axis);
  return node.axis === axis ? first + second + 7 : Math.max(first, second);
}
function fitsLayout(node: LayoutNode, width: number, height: number): boolean {
  if (node.type === "group") return width >= 148 && height >= 98;
  return node.axis === "horizontal"
    ? fitsLayout(node.first, (width - 7) * node.ratio, height) &&
        fitsLayout(node.second, (width - 7) * (1 - node.ratio), height)
    : fitsLayout(node.first, width, (height - 7) * node.ratio) &&
        fitsLayout(node.second, width, (height - 7) * (1 - node.ratio));
}
