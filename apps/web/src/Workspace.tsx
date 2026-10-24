import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import { createPortal, flushSync } from "react-dom";
import { GripVertical, X, Maximize2, Minimize2 } from "lucide-react";
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
  visibleRoot,
} from "./workspaceLayout";
import type {
  DropEdge,
  Group,
  PanelId,
  WorkspaceLayout,
} from "./workspaceLayout";
import {
  tileGeometry,
  tileDrop,
  minimumExtent,
  canDockTile,
} from "./tileGeometry";
import type { TileRect, Divider } from "./tileGeometry";
export function useWorkspace(projectId: string) {
  const [initial] = useState(() => {
    const layout = readLayout(projectId);
    try {
      const state = JSON.parse(
        localStorage.getItem("java-blueprints:window-state:" + projectId) ??
          "null",
      );
      return {
        layout,
        focused: panelIds.includes(state?.focused)
          ? (state.focused as PanelId)
          : ("graph" as PanelId),
        maximized:
          panelIds.includes(state?.maximized) &&
          !layout.hidden?.includes(state.maximized)
            ? (state.maximized as PanelId)
            : null,
      };
    } catch {
      return { layout, focused: "graph" as PanelId, maximized: null };
    }
  });
  const [layout, setLayout] = useState(initial.layout);
  const [maximized, setMaximized] = useState<PanelId | null>(initial.maximized);
  const [focused, setFocused] = useState<PanelId>(initial.focused);
  useEffect(() => {
    try {
      localStorage.setItem(
        "java-blueprints:window-state:" + projectId,
        JSON.stringify({ focused, maximized }),
      );
    } catch {}
  }, [projectId, focused, maximized]);
  function animate(change: () => void): Promise<void> {
    // CSS geometry transitions preserve live content; no screenshot overlays.
    flushSync(change);
    return Promise.resolve();
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
type Drag = {
  panel: PanelId;
  base: WorkspaceLayout;
  preview: WorkspaceLayout;
  x: number;
  y: number;
  startX: number;
  startY: number;
  source: TileRect;
  moved: boolean;
  target: string | null;
  edge: DropEdge;
};
export default function Workspace({
  controller: c,
  panels,
  sidebarChrome,
  canvasTitle,
}: {
  controller: WorkspaceController;
  panels: Record<PanelId, ReactNode>;
  sidebarChrome?: ReactNode;
  canvasTitle?: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null),
    storage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null),
    wasDrag = useRef(false);
  const [hosts] = useState(
    () =>
      Object.fromEntries(
        panelIds.map((id) => {
          const host = document.createElement("div");
          host.className = "workspace-panel-host";
          host.dataset.panelId = id;
          return [id, host];
        }),
      ) as Record<PanelId, HTMLDivElement>,
  );
  const mounts = useMemo(
    () =>
      Object.fromEntries(
        panelIds.map((panel) => [
          panel,
          (slot: HTMLDivElement | null) => {
            const host = hosts[panel];
            if (slot) {
              host.inert = false;
              slot.appendChild(host);
            } else if (storage.current) {
              host.inert = true;
              storage.current.appendChild(host);
            }
          },
        ]),
      ) as Record<PanelId, (slot: HTMLDivElement | null) => void>,
    [hosts],
  );
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    for (const id of panelIds)
      if (!hosts[id].isConnected && storage.current) {
        hosts[id].inert = true;
        storage.current.appendChild(hosts[id]);
      }
  });
  const compact = size.width > 0 && size.width < 980;
  const bounds = {
    x: 12,
    y: 78,
    width: Math.max(1, size.width - 24),
    height: Math.max(1, size.height - 160),
  };
  const layout = drag?.moved ? drag.preview : c.layout;
  const root = visibleRoot(layout);
  const geometry = tileGeometry(root, bounds);
  const shown = visiblePanels(layout);
  const focus =
    c.maximized ??
    (compact ? (shown.includes(c.focused) ? c.focused : "graph") : null);
  useLayoutEffect(() => {
    hosts.graph.inert = !!focus && focus !== "graph";
  }, [focus, hosts]);
  useEffect(() => {
    if (dragRef.current && c.layout !== dragRef.current.base) {
      dragRef.current = null;
      setDrag(null);
      document.body.classList.remove("is-tiling");
    }
  }, [c.layout]);
  const projectTile = geometry.tiles.find(
    (t) =>
      t.group.active === "project" &&
      t.rect.x === bounds.x &&
      t.rect.y === bounds.y,
  );
  useLayoutEffect(() => {
    const shell = container.current?.closest<HTMLElement>(".workbench");
    shell?.style.setProperty(
      "--sidebar-width",
      !compact && projectTile ? projectTile.rect.width + 24 + "px" : "20px",
    );
  }, [projectTile?.rect.width, compact]);
  const aperture =
    geometry.tiles.find((t) => t.group.active === "graph")?.rect ?? bounds;
  useEffect(() => {
    function move(event: PointerEvent) {
      const current = dragRef.current,
        box = container.current?.getBoundingClientRect();
      if (!current || !box) return;
      const x = event.clientX - box.left,
        y = event.clientY - box.top;
      const moved =
        current.moved || Math.hypot(x - current.startX, y - current.startY) > 6;
      if (!moved) return;
      event.preventDefault();
      const targets = tileGeometry(visibleRoot(current.base), bounds).tiles;
      const target = targets.find(
        (t) =>
          x >= t.rect.x &&
          x <= t.rect.x + t.rect.width &&
          y >= t.rect.y &&
          y <= t.rect.y + t.rect.height &&
          !t.group.tabs.includes(current.panel),
      );
      let preview = current.base,
        edge: DropEdge = "center";
      if (target) {
        edge = tileDrop(target.rect, x, y);
        if (target.group.active === "graph" && edge === "center")
          edge = "right";
        if (canDockTile(target.rect, edge))
          preview = movePanel(
            current.base,
            current.panel,
            target.group.id,
            edge,
          );
      }
      dragRef.current = {
        ...current,
        x,
        y,
        moved,
        preview,
        target: target?.group.id ?? null,
        edge,
      };
      setDrag(dragRef.current);
    }
    function finish(event: PointerEvent) {
      if (!dragRef.current) return;
      if (event.type === "pointerup" && dragRef.current.moved)
        c.setLayout(dragRef.current.preview);
      wasDrag.current = dragRef.current.moved;
      dragRef.current = null;
      setDrag(null);
      document.body.classList.remove("is-tiling");
    }
    function closeMenus(event: PointerEvent) {
      container.current
        ?.querySelectorAll<HTMLDetailsElement>(".workspace-move-menu[open]")
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    }
    function cancel(event: KeyboardEvent) {
      if (event.key === "Escape" && !dragRef.current) {
        const menu = container.current?.querySelector<HTMLDetailsElement>(
          ".workspace-move-menu[open]",
        );
        if (menu) {
          menu.open = false;
          menu.querySelector<HTMLElement>("summary")?.focus();
        }
      }
      if (event.key === "Escape" && dragRef.current) {
        dragRef.current = null;
        setDrag(null);
        document.body.classList.remove("is-tiling");
      }
    }
    document.addEventListener("pointerdown", closeMenus);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", cancel);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", cancel);
      document.body.classList.remove("is-tiling");
    };
  }, [size.width, size.height, c.setLayout]);
  function begin(panel: PanelId, event: React.PointerEvent) {
    if (compact || event.button !== 0 || panel === "graph") return;
    const box = container.current!.getBoundingClientRect();
    const tile = tileGeometry(visibleRoot(c.layout), bounds).tiles.find((t) =>
      t.group.tabs.includes(panel),
    );
    if (!tile) return;
    const x = event.clientX - box.left,
      y = event.clientY - box.top;
    wasDrag.current = false;
    dragRef.current = {
      panel,
      base: c.layout,
      preview: c.layout,
      x,
      y,
      startX: x,
      startY: y,
      source:
        panel === "project" &&
        tile.rect.x === bounds.x &&
        tile.rect.y === bounds.y
          ? {
              ...tile.rect,
              y: 10,
              height:
                tile.rect.height +
                bounds.y -
                10 +
                (Math.abs(
                  tile.rect.y + tile.rect.height - bounds.y - bounds.height,
                ) < 1
                  ? 72
                  : 0),
            }
          : tile.rect,
      moved: false,
      target: null,
      edge: "center",
    };
    setDrag(dragRef.current);
    document.body.classList.add("is-tiling");
  }
  function groupView(group: Group, initial: TileRect) {
    if (group.active === "graph")
      return (
        <div
          key="graph-aperture"
          className="graph-aperture"
          data-graph-aperture
          data-group-id={group.id}
          style={{
            left: initial.x,
            top: initial.y,
            width: initial.width,
            height: initial.height,
          }}
        />
      );
    let rect = initial;
    const sidebar =
      group.active === "project" &&
      initial.x === bounds.x &&
      initial.y === bounds.y &&
      !focus;
    if (sidebar)
      rect = {
        ...rect,
        y: 10,
        height:
          initial.height +
          bounds.y -
          10 +
          (Math.abs(initial.y + initial.height - bounds.y - bounds.height) < 1
            ? 72
            : 0),
      };
    if (focus)
      rect = {
        x: 12,
        y: 78,
        width: Math.max(1, size.width - 24),
        height: Math.max(1, size.height - 160),
      };
    const moving = drag?.panel === group.active && drag.moved;
    const style: CSSProperties = moving
      ? {
          left: drag.source.x + drag.x - drag.startX,
          top: drag.source.y + drag.y - drag.startY,
          width: drag.source.width,
          height: drag.source.height,
        }
      : { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
    return (
      <section
        key={group.active}
        className={
          "workspace-group glass-tile" +
          (moving ? " tile-dragging" : "") +
          (sidebar ? " project-shell" : "")
        }
        aria-label={panelLabels[group.active]}
        data-group-id={group.id}
        data-tile-panel={group.active}
        style={style}
      >
        {group.active === "project" && sidebarChrome && (
          <div className="workspace-sidebar-chrome">{sidebarChrome}</div>
        )}
        <header
          className="workspace-panel-header"
          data-panel-header={group.active}
        >
          <div
            className="workspace-panel-tabs"
            role="tablist"
            aria-label="Панели"
          >
            {group.tabs
              .filter((p) => p !== "graph")
              .map((panel) => (
                <button
                  key={panel}
                  role="tab"
                  aria-selected={panel === group.active}
                  data-panel-tab={panel}
                  className={panel === group.active ? "active" : ""}
                  onClick={() => void c.reveal(panel)}
                >
                  {panelLabels[panel]}
                </button>
              ))}
          </div>
          <button
            className="workspace-panel-action"
            aria-label={
              c.maximized === group.active
                ? "Восстановить панель"
                : "Развернуть " + panelLabels[group.active]
            }
            onClick={() =>
              void c.maximize(
                c.maximized === group.active ? null : group.active,
              )
            }
          >
            {c.maximized === group.active ? (
              <Minimize2 size={13} />
            ) : (
              <Maximize2 size={13} />
            )}
          </button>
          <button
            className="workspace-panel-action"
            aria-label={"Скрыть " + panelLabels[group.active]}
            onClick={() => void c.hide(group.active)}
          >
            <X size={14} />
          </button>
          <MovePanelMenu
            panel={group.active}
            layout={c.layout}
            onMove={(target, edge) =>
              void c.animateLayout((l) =>
                movePanel(l, group.active, target, edge),
              )
            }
            onPointerDown={(e) => begin(group.active, e)}
            suppressClick={() => wasDrag.current}
            canMove={(targetId, edge) => {
              const tile = geometry.tiles.find((t) => t.group.id === targetId);
              return (
                !!tile &&
                canDockTile(
                  tile.rect,
                  edge === "center" && tile.group.active === "graph"
                    ? "right"
                    : edge,
                )
              );
            }}
          />
        </header>
        <div className="workspace-panel-slot" ref={mounts[group.active]} />
      </section>
    );
  }
  const tiles = focus
    ? [
        {
          group: {
            type: "group" as const,
            id: "focused",
            tabs: [focus],
            active: focus,
          },
          rect: bounds,
        },
      ]
    : geometry.tiles;
  return (
    <div
      className="configurable-workspace glass-workspace"
      style={
        {
          "--canvas-left": aperture.x + "px",
          "--canvas-top": aperture.y + "px",
          "--canvas-width": aperture.width + "px",
          "--canvas-height": aperture.height + "px",
        } as CSSProperties
      }
      ref={container}
      data-workspace-dragging={drag?.moved || undefined}
    >
      <div className="workspace-canvas-background" ref={mounts.graph} />
      {!focus || focus === "graph" ? (
        <div
          className="canvas-heading"
          style={{
            left: aperture.x + 22,
            top: aperture.y + 9,
            maxWidth: aperture.width - 44,
          }}
        >
          {canvasTitle}
        </div>
      ) : null}
      {compact && (
        <nav className="workspace-mobile-panels">
          <select
            aria-label="Открытая панель"
            value={focus ?? "graph"}
            onChange={(e) => void c.reveal(e.target.value as PanelId)}
          >
            {panelIds.map((p) => (
              <option key={p} value={p}>
                {panelLabels[p]}
              </option>
            ))}
          </select>
        </nav>
      )}
      <div className="workspace-layout">
        {tiles.map((t) => groupView(t.group, t.rect))}
        {!focus &&
          geometry.dividers.map((d) => (
            <TileSeparator
              key={d.node.id}
              divider={d}
              onChange={(ratio) =>
                c.setLayout((l) => resizeSplit(l, d.node.id, ratio))
              }
            />
          ))}
      </div>
      <div hidden inert ref={storage} data-workspace-storage="true" />
      {panelIds.map((panel) =>
        createPortal(panels[panel], hosts[panel], panel),
      )}
    </div>
  );
}
function TileSeparator({
  divider: d,
  onChange,
}: {
  divider: Divider;
  onChange: (ratio: number) => void;
}) {
  const start = useRef<{ at: number; ratio: number } | null>(null);
  const horizontal = d.node.axis === "horizontal",
    span = (horizontal ? d.parent.width : d.parent.height) - 8;
  const min = Math.max(
      0.15,
      minimumExtent(d.node.first, d.node.axis) / Math.max(1, span),
    ),
    max = Math.min(
      0.85,
      1 - minimumExtent(d.node.second, d.node.axis) / Math.max(1, span),
    );
  const resize = (value: number) => {
    if (min <= max) onChange(Math.max(min, Math.min(max, value)));
  };
  return (
    <div
      className={
        "workspace-separator " +
        (horizontal ? "resize-horizontal" : "resize-vertical")
      }
      style={{
        left: d.rect.x,
        top: d.rect.y,
        width: d.rect.width,
        height: d.rect.height,
      }}
      role="separator"
      tabIndex={0}
      data-split-id={d.node.id}
      aria-label={horizontal ? "Ширина панелей" : "Высота панелей"}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-valuemin={Math.min(min, max) * 100}
      aria-valuemax={Math.max(min, max) * 100}
      aria-valuenow={d.node.ratio * 100}
      onPointerDown={(e) => {
        start.current = {
          at: horizontal ? e.clientX : e.clientY,
          ratio: d.node.ratio,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (start.current)
          resize(
            start.current.ratio +
              ((horizontal ? e.clientX : e.clientY) - start.current.at) / span,
          );
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e) => {
        const delta = (horizontal ? e.key === "ArrowLeft" : e.key === "ArrowUp")
          ? -0.03
          : (horizontal ? e.key === "ArrowRight" : e.key === "ArrowDown")
            ? 0.03
            : 0;
        if (delta) {
          e.preventDefault();
          resize(d.node.ratio + delta);
        }
      }}
    />
  );
}
function MovePanelMenu({
  panel,
  layout,
  onMove,
  onPointerDown,
  suppressClick,
  canMove,
}: {
  panel: PanelId;
  layout: WorkspaceLayout;
  onMove: (target: string, edge: DropEdge) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  suppressClick: () => boolean;
  canMove: (target: string, edge: DropEdge) => boolean;
}) {
  const destinations = groups(visibleRoot(layout)).filter(
    (g) => !g.tabs.includes(panel),
  );
  const [target, setTarget] = useState("");
  const [edge, setEdge] = useState<DropEdge>("center");
  const selected = destinations.some((g) => g.id === target)
    ? target
    : (destinations[0]?.id ?? "");
  return (
    <details className="workspace-move-menu">
      <summary
        className="tile-grip"
        aria-label={"Переместить " + panelLabels[panel]}
        title="Переместить панель"
        onPointerDown={onPointerDown}
        onClick={(e) => {
          if (e.detail !== 0 && suppressClick()) e.preventDefault();
        }}
      >
        <GripVertical size={17} />
      </summary>
      <div className="workspace-move-popup">
        <label>
          Рядом с панелью
          <select
            aria-label="Панель назначения"
            value={selected}
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
              <option key={e} value={e} disabled={!canMove(selected, e)}>
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
          disabled={!selected || !canMove(selected, edge)}
          onClick={(e) => {
            onMove(selected, edge);
            e.currentTarget.closest("details")?.removeAttribute("open");
          }}
        >
          Переместить
        </button>
      </div>
    </details>
  );
}
