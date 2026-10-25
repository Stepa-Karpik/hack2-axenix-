import { useEffect, useState, useMemo, useCallback, useRef, memo } from "react";
import useFlowRoutes from "./useFlowRoutes";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  BaseEdge,
  EdgeLabelRenderer,
  ViewportPortal,
  useViewport,
} from "@xyflow/react";
import type {
  Node,
  NodeProps,
  NodeChange,
  Edge,
  EdgeProps,
  ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./flowUX.css";
import {
  baseNodeAt,
  previewScene,
  previewFingerprint,
  dismissedPreviewKeys,
  previewHitSnapshot,
} from "./flowPreview";
import { validOverviewPositions } from "./flowRouting";
import {
  Maximize2,
  Braces,
  CircleStop,
  CornerDownLeft,
  Diamond,
  Repeat2,
  Variable,
  CornerDownRight,
  SquareFunction,
  ArrowUpRight,
  GitMerge,
} from "lucide-react";
import type { RouteBox, RouteSide } from "./flowLayout";
import type { Graph, GraphNode, Layout, SemanticModel } from "./types";
import {
  arrangeFlow,
  executionNodes,
  routeFlowEdges,
  flowPorts,
  routePort,
  branchLabelPosition,
  routeOrthogonal,
  roundedRoute,
  compactFlowLabel,
  dispatchLabelPosition,
  flowLabelTitle,
  loopAreas,
  visualKind,
  methodViewKey,
  stableNodeKeys,
  placeManualFlow,
} from "./flowLayout";
import { api, projectPath } from "./api";
import { operationAnchor } from "./state";
type FlowData = {
  label: string;
  kind: string;
  line: string;
  selected: boolean;
  executionRole?: GraphNode["executionRole"];
  fullLabel?: string;
  visualKind?: ReturnType<typeof visualKind>;
  branch?: boolean;
  dropPosition?: string;
  groupActive?: boolean;
};
const nodeIcons = {
  method: Braces,
  terminal: CircleStop,
  return: CornerDownLeft,
  condition: Diamond,
  loop: Repeat2,
  variable: Variable,
  call: ArrowUpRight,
  operation: SquareFunction,
  jump: CornerDownRight,
  join: GitMerge,
  structure: Braces,
};
function BlueprintNode({ data, id }: NodeProps<Node<FlowData>>) {
  const Glyph = nodeIcons[data.visualKind ?? "operation"];
  return (
    <div
      data-insert-position={data.dropPosition}
      data-node-kind={data.kind}
      data-node-id={id}
      data-visual-kind={data.visualKind}
      className={
        "blueprint-node " +
        (data.selected ? "selected " : "") +
        data.kind +
        " role-" +
        (data.executionRole ?? "unknown") +
        " visual-" +
        (data.visualKind ?? "operation")
      }
      title={data.fullLabel}
    >
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Handle
          key={`target-${side}`}
          id={`target-${side}`}
          type="target"
          position={side as Position}
          isConnectable={false}
        />
      ))}
      {data.dropPosition && (
        <span className="block-insert-hint">
          {data.dropPosition === "before" || data.dropPosition === "body_start"
            ? "Вставить перед"
            : "Вставить после"}
        </span>
      )}
      <Glyph
        className="graph-node-icon"
        size={15}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {isIterationProtocol(data) ? (
        <div className="node-label">{data.label}</div>
      ) : data.executionRole === "structural" && data.kind !== "entry" ? (
        <>
          <div className="node-label">{data.label}</div>
          <span className="structural-line">{data.line}</span>
        </>
      ) : (
        <>
          <div className="node-meta">
            <span>
              {data.kind === "ExpressionStmt" && data.visualKind === "variable"
                ? "Переменная"
                : data.kind === "ExpressionStmt" && data.visualKind === "call"
                  ? "Вызов"
                  : kindName(data.kind)}
            </span>
            <span>{data.line}</span>
          </div>
          <div className="node-label">{data.label}</div>
        </>
      )}
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Handle
          key={`source-${side}`}
          id={`source-${side}`}
          type="source"
          position={side as Position}
          isConnectable={false}
        />
      ))}
    </div>
  );
}
function LoopAreaNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div
      className="graph-loop-area"
      data-loop-area={data.fullLabel}
      data-loop-members={data.label}
      aria-hidden="true"
    >
      <span>
        <Repeat2 size={12} />
        Повторяемая область
      </span>
    </div>
  );
}
function MethodAreaNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div
      className={"graph-method-frame" + (data.groupActive ? " active" : "")}
      data-method-frame={data.fullLabel}
    >
      <span>{data.label}</span>
    </div>
  );
}
export type FlowPreview = {
  kind: "statement" | "condition" | "loop";
  anchorNodeId: string;
  position: "before" | "after" | "body_start" | "body_end";
  source?: string;
  request?: number;
};
export function kindName(kind: string) {
  return (
    (
      {
        entry: "Метод",
        exit: "Выход",
        normal_exit: "Завершение",
        exceptional_exit: "Исключение",
        for_init: "Инициализация",
        for_update: "Обновление",
        loop_back: "Повтор цикла",
        IfStmt: "Если",
        condition_test: "Проверка",
        resource_init: "Открытие ресурса",
        resource_primary: "Основное исключение",
        resource_check: "Ресурс открыт?",
        resource_close: "Закрытие ресурса",
        resource_suppression_check: "То же исключение?",
        resource_suppress: "Подавить исключение",
        resource_throw: "Ошибка закрытия",
        resource_resume: "Продолжение после ресурсов",
        try_entry: "Защищённый блок",
        catch_test: "Тип исключения",
        catch_entry: "Обработчик",
        finally_entry: "Завершение finally",
        finally_resume: "Продолжение",
        SwitchStmt: "Выбор",
        switch_selector: "Значение",
        switch_case: "Ветка",
        WhileStmt: "Пока",
        ForStmt: "Цикл",
        ForEachStmt: "Обход",
        foreach_source: "Источник",
        foreach_check: "Есть элемент?",
        foreach_bind: "Элемент",
        foreach_advance: "Следующая итерация",
        DoStmt: "Повтор",
        ReturnStmt: "Возврат",
        ExpressionStmt: "Действие",
        VariableDeclarationExpr: "Переменная",
        ThrowStmt: "Исключение",
        BreakStmt: "Выход",
        ContinueStmt: "Следующая итерация",
        condition: "Условие",
        if: "Условие",
        loop: "Цикл",
        return: "Возврат",
        statement: "Действие",
        expression: "Выражение",
        merge: "Объединение",
        block: "Блок",
        opaque: "Точный поток не поддерживается",
      } as Record<string, string>
    )[kind] ?? kind
  );
}
export function isIterationProtocol(
  node: Pick<GraphNode, "kind" | "executionRole">,
) {
  return (
    node.executionRole === "synthetic" &&
    ["foreach_check", "foreach_bind", "foreach_advance"].includes(node.kind)
  );
}
export function nodeCaption(
  node: Pick<GraphNode, "kind" | "label" | "executionRole">,
) {
  if (node.kind === "opaque")
    return "Точный поток управления не поддерживается";
  return isIterationProtocol(node) ? kindName(node.kind) : node.label;
}
function ShortcutEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps<
  Edge<{
    routeX: number;
    boxes: RouteBox[];
    fullLabel?: string;
    labelAtTarget?: boolean;
    sourceSide?: RouteSide;
    targetSide?: RouteSide;
    compact?: boolean;
    branch?: boolean;
    returning?: boolean;
    departure?: number;
    arrival?: number;
    highlighted?: boolean;
    provisional?: boolean;
    plannedRoute?: {
      points: { x: number; y: number }[];
      complete: boolean;
      path?: string;
    };
    pending?: boolean;
  }>
>) {
  const routeX = data!.routeX;
  const route = useMemo(() => {
    const value =
      data?.plannedRoute ??
      routeOrthogonal(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        routeX,
        data?.pending ? [] : data!.boxes,
        data?.departure ?? 22,
        data?.sourceSide,
        data?.arrival ?? 22,
        data?.targetSide,
        data?.compact,
      );
    return data?.pending ? { ...value, complete: false } : value;
  }, [sourceX, sourceY, targetX, targetY, routeX, data]);
  const path =
    data?.plannedRoute?.path ??
    roundedRoute(route.points, 16, data?.pending ? [] : (data?.boxes ?? []));
  const horizontal = route.points
    .slice(1)
    .findIndex(
      (point, index) =>
        point.y === route.points[index].y &&
        Math.abs(point.x - route.points[index].x) > 24,
    );
  const labelStart = route.points[Math.max(0, horizontal)],
    labelEnd = route.points[Math.max(1, horizontal + 1)];
  const targetLabel = dispatchLabelPosition({ x: targetX, y: targetY });
  const branchLabel = data?.branch;
  const branchAt = branchLabelPosition(
    { x: sourceX, y: sourceY },
    data?.sourceSide ?? "bottom",
  );
  const labelX = branchLabel
    ? branchAt.x
    : data?.labelAtTarget
      ? targetLabel.x
      : labelStart.x +
        Math.sign(labelEnd.x - labelStart.x) *
          Math.min(48, Math.abs(labelEnd.x - labelStart.x) / 2);
  const labelY = branchLabel
    ? branchAt.y
    : data?.labelAtTarget
      ? targetLabel.y
      : labelStart.y;
  return (
    <>
      <g
        style={{ color: style?.stroke as string }}
        data-shortcut-source={source}
        data-shortcut-target={target}
        data-route-status={route.complete ? "clear" : "limited"}
        data-route-source={source}
        data-route-highlighted={data?.highlighted || undefined}
        data-route-target={target}
        data-provisional-route={data?.provisional || undefined}
        data-route-returning={data?.returning || undefined}
      >
        {data?.provisional && (
          <title>
            Предварительное расположение; исходный поток ещё не изменён
          </title>
        )}
        {!route.complete && (
          <title>Маршрут ограничен: обход узлов не гарантирован</title>
        )}
        <BaseEdge
          id={id}
          path={path}
          markerEnd={markerEnd}
          style={route.complete ? style : { ...style, strokeDasharray: "4 4" }}
        />
      </g>
      {label && (
        <EdgeLabelRenderer>
          <span
            className={"shortcut-label" + (branchLabel ? " branch-label" : "")}
            title={flowLabelTitle(data?.fullLabel, route.complete)}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { shortcut: ShortcutEdge };
function CanvasBackground() {
  const { zoom } = useViewport();
  const scale = 2 ** Math.floor(Math.log2(Math.max(0.01, zoom)));
  return (
    <Background
      gap={22 / scale}
      size={1.1 / Math.max(0.01, zoom)}
      color="var(--graph-grid, #999)"
    />
  );
}
const nodeTypes = {
  blueprint: memo(BlueprintNode),
  loopArea: LoopAreaNode,
  methodArea: MethodAreaNode,
};
export default function FlowCanvas({
  graph,
  methodId,
  selected,
  onSelect,
  projectId,
  stale,
  readOnly = false,
  semantics,
  staleMessage,
  onRefresh,
  refreshing,
  onInsert,
  onEdit,
  overview = false,
  preview,
  focusNodeId,
  focusRequest,
}: {
  graph: Graph;
  methodId: string;
  selected?: string;
  onSelect: (node: GraphNode) => void;
  projectId: string;
  stale: boolean;
  readOnly?: boolean;
  staleMessage?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onInsert?: (nodeId: string, kind: string, position: string) => void;
  onEdit?: (node: GraphNode) => void;
  semantics?: SemanticModel | null;
  overview?: boolean;
  preview?: FlowPreview | null;
  focusNodeId?: string | null;
  focusRequest?: number;
}) {
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    highlightId: string;
    position: string;
  } | null>(null);
  const [hoverKind, setHoverKind] = useState<FlowPreview["kind"] | null>(null);
  const hoverScene = useRef<{ scope: string; nodes: Node<FlowData>[] } | null>(
    null,
  );
  const [dismissedPreviews, setDismissedPreviews] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Node<FlowData>[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutError, setLayoutError] = useState("");
  const semanticsRef = useRef(semantics);
  semanticsRef.current = semantics;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const flow = useRef<Pick<
    ReactFlowInstance<Node<FlowData>>,
    "setViewport" | "getViewport" | "getNodes"
  > | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shell = container.current?.closest<HTMLElement>(".workbench");
    return () => shell?.removeAttribute("data-canvas-moving");
  }, []);
  const viewportWidth = useRef(0);
  const method = graph.methods.find((candidate) => candidate.id === methodId);
  const scopeMethodId = overview ? "overview" : methodId;
  const viewKey = overview
    ? JSON.stringify([projectId, "overview"])
    : methodViewKey(projectId, method, methodId);
  const overviewStorageKey = `java-blueprints:overview:v1:${projectId}`;
  const overviewStorageKeyRef = useRef(overviewStorageKey);
  overviewStorageKeyRef.current = overviewStorageKey;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const overviewOrigins = useRef(new Map<string, { x: number; y: number }>());
  const overviewManualIds = useRef(new Set<string>());
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [spacePan, setSpacePan] = useState(false);
  const gestureRef = useRef<{ scope: string; committed: boolean } | null>(null);
  const clickSelection = useRef<{
    scope: string;
    nodeId: string;
    ids: Set<string>;
  } | null>(null);
  const consumedFocus = useRef("");
  const nodesScope = useRef("");
  const cameraKey = `java-blueprints:camera:v3:${viewKey}`;
  const initializedCamera = useRef<string | null>(null);
  const initializedManual = useRef(new Set<string>());
  const manualPositions = useRef(
    new Map<string, Map<string, { x: number; y: number }>>(),
  );
  const cameraKeyRef = useRef(cameraKey);
  cameraKeyRef.current = cameraKey;
  function safeArea() {
    const viewport = container.current?.getBoundingClientRect();
    const area = container.current
      ?.closest(".glass-workspace")
      ?.querySelector("[data-graph-aperture]")
      ?.getBoundingClientRect();
    return viewport && area
      ? {
          x: area.x - viewport.x,
          y: area.y - viewport.y,
          width: area.width,
          height: area.height,
        }
      : {
          x: 0,
          y: 0,
          width: viewport?.width ?? 500,
          height: viewport?.height ?? 500,
        };
  }
  function persistCamera() {
    try {
      const viewport = flow.current?.getViewport();
      if (viewport)
        localStorage.setItem(cameraKeyRef.current, JSON.stringify(viewport));
    } catch {}
  }
  function persistOverview(current: Node<FlowData>[] = nodesRef.current) {
    if (provisional) return;
    const real = new Map(graph.nodes.map((n) => [n.id, n]));
    const positions = current
      .filter((n) => real.has(n.id))
      .map((n) => ({
        nodeId: n.id,
        methodId: real.get(n.id)!.methodId,
        ...n.position,
      }));
    const bindings = new Map(
      executionNodes(methodNodes, graph.edges).map((n) => [n.id, n.methodId]),
    );
    if (!validOverviewPositions(positions, bindings)) return;
    try {
      localStorage.setItem(
        overviewStorageKeyRef.current,
        JSON.stringify({
          schemaVersion: 1,
          projectId,
          revisionId: graph.revisionId,
          analysisId: graph.analysisId,
          sourceMapVersion: graph.sourceMapVersion,
          positions,
          viewport: flow.current?.getViewport(),
          origins: [...overviewOrigins.current],
          manualNodeIds: [...overviewManualIds.current],
          manualPositions: current
            .filter(
              (n) =>
                overviewManualIds.current.has(n.id) && overviewKeys.has(n.id),
            )
            .map((n) => ({ key: overviewKeys.get(n.id), ...n.position })),
        }),
      );
    } catch {
      setLayoutError("Не удалось сохранить координаты в этом браузере");
    }
  }
  function fitCanvas() {
    if (!nodes.length) return;
    const area = safeArea();
    const left = Math.min(...nodes.map((n) => n.position.x)),
      top = Math.min(...nodes.map((n) => n.position.y));
    const right = Math.max(
        ...nodes.map((n) => n.position.x + (n.measured?.width ?? 264)),
      ),
      bottom = Math.max(
        ...nodes.map((n) => n.position.y + (n.measured?.height ?? 84)),
      );
    const zoom = Math.max(
      overview ? 0.03 : 0.15,
      Math.min(
        1,
        (area.width - 100) / Math.max(1, right - left),
        (area.height - 150) / Math.max(1, bottom - top),
      ),
    );
    void flow.current
      ?.setViewport({
        x: area.x + area.width / 2 - ((left + right) / 2) * zoom,
        y: area.y + 100 + (area.height - 120) / 2 - ((top + bottom) / 2) * zoom,
        zoom,
      })
      .then(persistCamera);
  }

  const scope = `${projectId}/${graph.revisionId}/${graph.analysisId}/${scopeMethodId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    const focus = (event: Event) => {
      const id = (event as CustomEvent).detail?.nodeId;
      const node = nodesRef.current.find(candidate => candidate.id === id);
      if (!node || !flow.current) return;
      const area = safeArea(), zoom = Math.max(.75, Math.min(1, flow.current.getViewport().zoom));
      void flow.current.setViewport({ x: area.x + area.width / 2 - (node.position.x + 132) * zoom, y: area.y + area.height / 2 - (node.position.y + 42) * zoom, zoom });
    };
    window.addEventListener("java-blueprints:tour-focus-node", focus);
    return () => window.removeEventListener("java-blueprints:tour-focus-node", focus);
  }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,button,[contenteditable=true]",
          ))
      )
        return;
      event.preventDefault();
      setSpacePan(true);
    };
    const release = () => setSpacePan(false);
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);
  useEffect(() => {
    scopeRef.current = scope;
    return () => {
      if (scopeRef.current === scope) scopeRef.current = "";
    };
  }, [scope]);
  const methodNodes = useMemo(
    () =>
      overview
        ? graph.nodes
        : graph.nodes.filter((n) => n.methodId === methodId),
    [graph, scopeMethodId],
  );
  const overviewKeys = useMemo(() => {
    const result = new Map<string, string>(),
      counts = new Map<string, number>();
    for (const m of graph.methods) {
      const key = methodViewKey(projectId, m, m.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const m of graph.methods) {
      const key = methodViewKey(projectId, m, m.id);
      if (counts.get(key) !== 1) continue;
      for (const [id, nodeKey] of stableNodeKeys(
        graph.nodes.filter((n) => n.methodId === m.id),
      ))
        result.set(id, JSON.stringify([key, nodeKey]));
    }
    return result;
  }, [graph, projectId]);
  const nodeKeys = useMemo(() => stableNodeKeys(methodNodes), [methodNodes]);
  useEffect(() => {
    if (
      !focusNodeId ||
      focusRequest === undefined ||
      !flow.current ||
      nodesScope.current !== scope
    )
      return;
    const token = JSON.stringify([projectId, focusNodeId, focusRequest]);
    if (consumedFocus.current === token) return;
    let id: string | undefined = focusNodeId;
    const visited = new Set<string>();
    while (id && !nodes.some((n) => n.id === id) && !visited.has(id)) {
      visited.add(id);
      id = methodNodes.find((n) => n.id === id)?.parentId ?? undefined;
    }
    const target = nodes.find((n) => n.id === id);
    if (!target) return;
    consumedFocus.current = token;
    initializedCamera.current = cameraKey;
    const area = safeArea(),
      zoom = Math.max(0.65, Math.min(1, flow.current.getViewport().zoom));
    void flow.current
      .setViewport({
        x:
          area.x +
          area.width / 2 -
          (target.position.x + (target.measured?.width ?? 264) / 2) * zoom,
        y:
          area.y +
          area.height / 2 -
          (target.position.y + (target.measured?.height ?? 84) / 2) * zoom,
        zoom,
      })
      .then(persistCamera);
  }, [
    focusNodeId,
    focusRequest,
    nodes,
    methodNodes,
    projectId,
    scope,
    cameraKey,
  ]);
  const ids = useMemo(
    () => new Set(executionNodes(methodNodes, graph.edges).map((n) => n.id)),
    [methodNodes, graph.edges],
  );
  const edges = useMemo(
    () =>
      graph.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          ...e,
          label:
            e.kind === "true"
              ? "да"
              : e.kind === "false"
                ? "нет"
                : e.label
                  ? compactFlowLabel(e.label)
                  : undefined,
          data: {
            fullLabel:
              [e.label, e.reason, e.completionContext]
                .filter(Boolean)
                .join("\n") || undefined,
          },
          sourceHandle:
            e.kind === "true" || e.kind === "false" ? e.kind : "next",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: e.kind === "loop" ? "#8b79af" : "#8c9691",
            width: 16,
            height: 16,
          },
          style: {
            stroke: e.kind === "loop" ? "#8b79af" : "#8c9691",
            strokeWidth: e.kind === "loop" ? 1.8 : 1.4,
          },
          labelStyle: { fontSize: 10, fill: "#7a8370" },
          type: "smoothstep",
        })),
    [graph, ids],
  );
  useEffect(() => {
    let active = true;
    setLayout(null);
    setLayoutError("");
    setMultiSelected([]);
    if (overview) return;
    api<Layout>(
      `${projectPath(projectId)}/revisions/${graph.revisionId}/layout?analysisId=${graph.analysisId}&methodId=${encodeURIComponent(methodId)}`,
    )
      .then((l) => {
        if (active) setLayout(l);
      })
      .catch((e) => {
        if (active) setLayoutError(e.message);
      });
    return () => {
      active = false;
    };
  }, [projectId, graph, scopeMethodId]);
  useEffect(() => {
    if (overview) {
      const visible = executionNodes(methodNodes, edges);
      const positions = new Map<string, { x: number; y: number }>();
      const origins = new Map<string, { x: number; y: number }>();
      let x = 0,
        y = 60,
        rowHeight = 0,
        lastFile = "";
      for (const m of [...graph.methods].sort(
        (a, b) =>
          a.sourceRange.filePath.localeCompare(b.sourceRange.filePath) ||
          a.sourceRange.startOffset - b.sourceRange.startOffset,
      )) {
        const all = methodNodes.filter((n) => n.methodId === m.id),
          shown = visible.filter((n) => n.methodId === m.id);
        const local = arrangeFlow(shown, edges, all),
          keys = stableNodeKeys(all);
        const manual = new Map<string, { x: number; y: number }>();
        try {
          const saved = JSON.parse(
            localStorage.getItem(
              `java-blueprints:positions:v2:${methodViewKey(projectId, m, m.id)}`,
            ) ?? "null",
          );
          if (Array.isArray(saved)) {
            const remembered = new Map<string, { x: number; y: number }>(saved);
            for (const n of shown) {
              const p = remembered.get(keys.get(n.id) ?? "");
              if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
                manual.set(n.id, p);
            }
          }
        } catch {}
        const placed = placeManualFlow(local, manual);
        const left = Math.min(0, ...[...placed.values()].map((p) => p.x)),
          top = Math.min(0, ...[...placed.values()].map((p) => p.y));
        const width =
            Math.max(300, ...[...placed.values()].map((p) => p.x + 264)) - left,
          height =
            Math.max(100, ...[...placed.values()].map((p) => p.y + 84)) - top;
        if (
          lastFile &&
          (lastFile !== m.sourceRange.filePath || x + width > 2200)
        ) {
          x = 0;
          y += rowHeight + 130;
          rowHeight = 0;
        }
        const origin = { x: x - left + 40, y: y - top + 40 };
        origins.set(m.id, origin);
        for (const [id, p] of placed)
          positions.set(id, { x: p.x + origin.x, y: p.y + origin.y });
        x += width + 160;
        rowHeight = Math.max(rowHeight, height);
        lastFile = m.sourceRange.filePath;
      }
      overviewOrigins.current = origins;
      const bindings = new Map(visible.map((n) => [n.id, n.methodId]));
      overviewManualIds.current = new Set();
      try {
        const snapshot = JSON.parse(
          localStorage.getItem(overviewStorageKey) ?? "null",
        );
        if (
          snapshot?.projectId === projectId &&
          snapshot.analysisId === graph.analysisId &&
          snapshot.revisionId === graph.revisionId &&
          snapshot.sourceMapVersion === graph.sourceMapVersion &&
          validOverviewPositions(snapshot.positions, bindings)
        ) {
          for (const p of snapshot.positions)
            positions.set(p.nodeId, { x: p.x, y: p.y });
          overviewManualIds.current = new Set(
            (snapshot.manualNodeIds ?? []).filter((id: string) =>
              bindings.has(id),
            ),
          );
        } else if (
          snapshot?.schemaVersion === 1 &&
          snapshot.projectId === projectId &&
          snapshot.sourceMapVersion === graph.sourceMapVersion &&
          Array.isArray(snapshot.manualPositions)
        ) {
          const counts = new Map<string, number>();
          for (const p of snapshot.manualPositions)
            if (p && typeof p.key === "string")
              counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
          for (const [id, key] of overviewKeys) {
            const p = snapshot.manualPositions.find(
              (p: { key: string }) => p?.key === key,
            );
            if (
              bindings.has(id) &&
              counts.get(key) === 1 &&
              p &&
              [p.x, p.y].every(
                (n: number) => Number.isFinite(n) && Math.abs(n) <= 1000000,
              )
            ) {
              positions.set(id, { x: p.x, y: p.y });
              overviewManualIds.current.add(id);
            }
          }
        }
      } catch {}
      nodesScope.current = scope;
      setNodes(
        visible.map((n) => ({
          id: n.id,
          type: "blueprint",
          position: positions.get(n.id)!,
          data: {
            kind: n.kind,
            executionRole: n.executionRole,
            fullLabel: n.label,
            label:
              n.kind === "entry"
                ? (graph.methods.find((m) => m.id === n.methodId)?.signature ??
                  "Метод")
                : n.kind === "switch_case"
                  ? compactFlowLabel(n.label, 26)
                  : n.executionRole === "structural"
                    ? kindName(n.kind)
                    : nodeCaption(n).split("\n")[0].slice(0, 110),
            line: n.sourceRange ? `L${n.sourceRange.startLine}` : "",
            selected: n.id === selectedRef.current,
            visualKind: visualKind(n, semanticsRef.current),
          },
        })),
      );
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (
            scopeRef.current !== scope ||
            initializedCamera.current === cameraKey ||
            !flow.current
          )
            return;
          initializedCamera.current = cameraKey;
          let camera: null | { x: number; y: number; zoom: number } = null;
          try {
            const saved = JSON.parse(localStorage.getItem(cameraKey) ?? "null");
            if (saved && [saved.x, saved.y, saved.zoom].every(Number.isFinite))
              camera = saved;
          } catch {}
          if (camera) void flow.current.setViewport(camera);
          else {
            const area = safeArea();
            const points = [...positions.values()];
            if (!points.length) return;
            const left = Math.min(...points.map((p) => p.x)),
              top = Math.min(...points.map((p) => p.y));
            const right = Math.max(...points.map((p) => p.x + 264)),
              bottom = Math.max(...points.map((p) => p.y + 84));
            const zoom = Math.max(
              0.03,
              Math.min(
                0.75,
                (area.width - 100) / Math.max(1, right - left),
                (area.height - 150) / Math.max(1, bottom - top),
              ),
            );
            void flow.current
              .setViewport({
                x: area.x + area.width / 2 - ((left + right) / 2) * zoom,
                y: area.y + area.height / 2 - ((top + bottom) / 2) * zoom,
                zoom,
              })
              .then(persistCamera);
          }
        }),
      );
      return;
    }
    const visible = executionNodes(methodNodes, edges);
    const positions = arrangeFlow(visible, edges, methodNodes);
    let remembered = manualPositions.current.get(viewKey);
    if (!remembered) {
      remembered = new Map();
      try {
        const saved: unknown = JSON.parse(
          localStorage.getItem(`java-blueprints:positions:v2:${viewKey}`) ??
            "null",
        );
        if (Array.isArray(saved)) {
          initializedManual.current.add(viewKey);
          for (const entry of saved) {
            if (
              Array.isArray(entry) &&
              typeof entry[0] === "string" &&
              entry[1] &&
              Number.isFinite(entry[1].x) &&
              Number.isFinite(entry[1].y)
            )
              remembered.set(entry[0], entry[1]);
          }
        }
      } catch {}
      manualPositions.current.set(viewKey, remembered);
    }
    const savedLayout =
      layout?.analysisId === graph.analysisId && layout.methodId === methodId
        ? layout
        : null;
    if (savedLayout && !initializedManual.current.has(viewKey)) {
      // Legacy API layouts contain every coordinate. Only deviations from the
      // canonical layout are evidence that a node was moved intentionally.
      for (const position of savedLayout.positions) {
        const key = nodeKeys.get(position.nodeId);
        const automatic = positions.get(position.nodeId);
        if (
          key &&
          automatic &&
          (Math.abs(position.x - automatic.x) > 0.5 ||
            Math.abs(position.y - automatic.y) > 0.5)
        )
          remembered.set(key, { x: position.x, y: position.y });
      }
      initializedManual.current.add(viewKey);
      try {
        localStorage.setItem(
          `java-blueprints:positions:v2:${viewKey}`,
          JSON.stringify([...remembered]),
        );
      } catch {}
    }
    const pinned = new Map<string, { x: number; y: number }>();
    // Current-analysis server layouts remain exact, including ambiguous equal
    // statements; only stable, explicit manual keys migrate to another analysis.
    for (const position of savedLayout?.positions ?? []) {
      const automatic = positions.get(position.nodeId);
      if (
        automatic &&
        (Math.abs(position.x - automatic.x) > 0.5 ||
          Math.abs(position.y - automatic.y) > 0.5)
      )
        pinned.set(position.nodeId, { x: position.x, y: position.y });
    }
    for (const node of visible) {
      const key = nodeKeys.get(node.id);
      const manual = key ? remembered.get(key) : undefined;
      if (manual) pinned.set(node.id, manual);
    }
    const arranged = placeManualFlow(positions, pinned);
    let selectedVisible = selectedRef.current;
    const visited = new Set<string>();
    while (
      selectedVisible &&
      !visible.some((node) => node.id === selectedVisible) &&
      !visited.has(selectedVisible)
    ) {
      visited.add(selectedVisible);
      selectedVisible =
        methodNodes.find((node) => node.id === selectedVisible)?.parentId ??
        undefined;
    }
    nodesScope.current = scope;
    setNodes(
      visible.map((n, i) => {
        const pos = arranged.get(n.id) ?? { x: 300, y: i * 135 };
        return {
          id: n.id,
          type: "blueprint",
          position: { x: pos.x, y: pos.y },
          data: {
            kind: n.kind,
            executionRole: n.executionRole,
            fullLabel: n.label,
            label:
              n.kind === "switch_case"
                ? compactFlowLabel(n.label, 26)
                : n.kind === "entry"
                  ? (graph.methods.find((m) => m.id === methodId)?.signature ??
                    "Начало")
                  : n.executionRole === "structural" &&
                      !["finally_entry", "catch_entry"].includes(n.kind)
                    ? kindName(n.kind)
                    : n.kind === "normal_exit"
                      ? "Завершение"
                      : n.kind === "exceptional_exit"
                        ? "Исключение"
                        : n.kind === "loop_back"
                          ? "Повтор цикла"
                          : nodeCaption(n).split("\n")[0].slice(0, 110),
            line: n.sourceRange ? `L${n.sourceRange.startLine}` : "",
            selected: n.id === selectedVisible,
            visualKind: visualKind(n, semanticsRef.current),
            branch: edges.some(
              (edge) =>
                edge.source === n.id && ["true", "false"].includes(edge.kind),
            ),
          },
        };
      }),
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          scopeRef.current !== scope ||
          initializedCamera.current === cameraKey
        )
          return;
        // A layout response selects the first viewport only. Later saves and
        // reanalysis must not reposition a method the user is already viewing.
        if (
          (!layoutError &&
            (!layout ||
              layout.analysisId !== graph.analysisId ||
              layout.methodId !== methodId)) ||
          !flow.current ||
          !visible.length
        )
          return;
        initializedCamera.current = cameraKey;
        viewportWidth.current =
          container.current?.clientWidth || viewportWidth.current || 500;
        let camera: { x: number; y: number; zoom: number } | null = null;
        try {
          const saved = JSON.parse(
            localStorage.getItem(cameraKeyRef.current) ?? "null",
          );
          if (
            saved &&
            [saved.x, saved.y, saved.zoom].every(Number.isFinite) &&
            saved.zoom >= 0.15 &&
            saved.zoom <= 1.5
          )
            camera = saved;
        } catch {}
        if (camera) void flow.current?.setViewport(camera).then(persistCamera);
        else if (
          layout?.analysisId === graph.analysisId &&
          layout.methodId === methodId &&
          layout.positions.length
        )
          void flow.current?.setViewport(layout.viewport).then(persistCamera);
        else {
          const entry = visible.find((node) => node.kind === "entry");
          const entryPosition = entry ? positions.get(entry.id) : undefined;
          const area = safeArea();
          void flow.current
            ?.setViewport({
              x:
                area.x +
                area.width / 2 -
                ((entryPosition?.x ?? 0) + 132) * 0.85,
              y: area.y + 120 - (entryPosition?.y ?? 0) * 0.85,
              zoom: 0.85,
            })
            .then(persistCamera);
        }
      }),
    );
  }, [methodNodes, edges, layout, layoutError, cameraKey, viewKey, nodeKeys]);
  // Binding availability can change while the editor has a dirty draft. Only
  // update visual categories; never reinitialize positions, selection or camera.
  useEffect(() => {
    const byId = new Map(methodNodes.map((node) => [node.id, node]));
    setNodes((current) =>
      current.map((node) => {
        const source = byId.get(node.id);
        return source
          ? {
              ...node,
              data: { ...node.data, visualKind: visualKind(source, semantics) },
            }
          : node;
      }),
    );
  }, [semantics, methodNodes]);
  useEffect(
    () =>
      setNodes((ns) => {
        let match = selected;
        const visited = new Set<string>();
        while (
          match &&
          !ns.some((n) => n.id === match) &&
          !visited.has(match)
        ) {
          visited.add(match);
          match =
            methodNodes.find((n) => n.id === match)?.parentId ?? undefined;
        }
        return ns.map((n) => ({
          ...n,
          data: { ...n.data, selected: n.id === match },
        }));
      }),
    [selected, methodNodes],
  );
  const proposedPreview = useMemo(
    () =>
      dropTarget && hoverKind
        ? {
            kind: hoverKind,
            anchorNodeId: dropTarget.id,
            position: dropTarget.position,
            source: undefined,
          }
        : preview,
    [
      dropTarget?.id,
      dropTarget?.position,
      hoverKind,
      preview?.kind,
      preview?.anchorNodeId,
      preview?.position,
      preview?.source,
      preview?.request,
    ],
  );
  const previewKey = previewFingerprint(scope, proposedPreview);
  const parentPreviewKey = previewFingerprint(scope, preview);
  const visualPreview =
    proposedPreview &&
    !dismissedPreviews.includes(previewKey) &&
    !stale &&
    !readOnly
      ? proposedPreview
      : null;
  const provisional = useMemo(
    () => previewScene(nodes, graph, visualPreview, stale || readOnly),
    [nodes, graph, visualPreview, stale, readOnly],
  );
  const sceneNodes = provisional?.nodes ?? nodes;
  const sceneNodesRef = useRef(sceneNodes);
  sceneNodesRef.current = sceneNodes;
  useEffect(() => {
    const start = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("application/x-blueprint-block"))
        hoverScene.current = {
          scope,
          nodes: previewHitSnapshot(sceneNodesRef.current),
        };
    };
    window.addEventListener("dragstart", start);
    return () => window.removeEventListener("dragstart", start);
  }, [scope]);
  useEffect(() => {
    const clearHover = () => {
      hoverScene.current = null;
      setDropTarget(null);
      setHoverKind(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDismissedPreviews(
          dismissedPreviewKeys(scope, proposedPreview, preview),
        );
        clearHover();
      }
    };
    const dragEnd = (event: DragEvent) => {
      if (event.dataTransfer?.dropEffect === "none")
        setDismissedPreviews(
          dismissedPreviewKeys(scope, proposedPreview, preview),
        );
      clearHover();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("dragend", dragEnd);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("dragend", dragEnd);
    };
  }, [previewKey, parentPreviewKey, scope]);
  useEffect(() => {
    hoverScene.current = null;
    setDropTarget(null);
    setHoverKind(null);
  }, [scope, stale, readOnly]);
  const routeScene = useMemo(() => {
    const methods = new Map(methodNodes.map((n) => [n.id, n.methodId]));
    return {
      boxes: sceneNodes.map((node) => ({
        id: node.id,
        ...node.position,
        width: node.measured?.width ?? 264,
        height: node.measured?.height ?? 84,
        methodId: methods.get(node.id),
      })),
      edges: edges.map(({ id, source, target, kind }) => ({
        id,
        source,
        target,
        kind,
      })),
      ghost: provisional
        ? {
            id: "preview-obstacle",
            ...provisional.ghost,
            methodId: provisional.methodId,
          }
        : undefined,
    };
  }, [sceneNodes, methodNodes, edges, provisional]);
  const routing = useFlowRoutes(routeScene);
  const renderedEdges = useMemo(() => {
    const routes = routeFlowEdges(sceneNodes, edges);
    const boxes = routeScene.boxes;
    const nodesById = new Map(sceneNodes.map((n) => [n.id, n]));
    const boxesById = new Map(boxes.map((b) => [b.id, b]));
    const planned = routing.routes;
    const realMethods = new Map(methodNodes.map((n) => [n.id, n.methodId]));
    const departures = new Map<number, number>();
    const arrivals = new Map<number, number>();
    return edges.map((edge) => {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      const sourceRow = source?.position.y ?? 0,
        targetRow = target?.position.y ?? 0;
      const leaving = departures.get(sourceRow) ?? 0,
        entering = arrivals.get(targetRow) ?? 0;
      departures.set(sourceRow, leaving + 1);
      arrivals.set(targetRow, entering + 1);
      const sourceBox = boxesById.get(edge.source);
      const targetBox = boxesById.get(edge.target);
      const plannedRoute = planned?.get(edge.id);
      const ports =
        plannedRoute ??
        (sourceBox && targetBox
          ? flowPorts(sourceBox, targetBox, edge.kind)
          : { sourceSide: "bottom" as const, targetSide: "top" as const });
      const kind = source?.data.visualKind;
      const exceptional = [
        "throw",
        "exception",
        "uncaught",
        "resource_exception",
      ].includes(edge.kind);
      const color =
        exceptional || kind === "return"
          ? "var(--graph-return)"
          : edge.kind === "loop" || kind === "loop" || kind === "jump"
            ? "var(--graph-violet)"
            : kind === "condition"
              ? "var(--graph-yellow)"
              : kind === "variable"
                ? "var(--graph-teal)"
                : kind === "call" || kind === "operation"
                  ? "var(--graph-blue)"
                  : "var(--graph-green)";
      return {
        ...edge,
        sourceHandle: `source-${ports.sourceSide}`,
        targetHandle: `target-${ports.targetSide}`,
        style: {
          ...edge.style,
          stroke: color,
          strokeDasharray:
            provisional?.movedMethods.has(realMethods.get(edge.source) ?? "") ||
            edge.certainty === "conservative"
              ? "5 4"
              : undefined,
        },
        markerEnd: { ...edge.markerEnd, color },
        type: "shortcut",
        data: {
          ...edge.data,
          provisional: provisional?.movedMethods.has(
            realMethods.get(edge.source) ?? "",
          ),
          highlighted: selected
            ? edge.source === selected || edge.target === selected
            : ["normal", "next", "true"].includes(edge.kind),
          routeX:
            routes.get(edge.id) ??
            ((source?.position.x ?? 0) + (target?.position.x ?? 0)) / 2 + 132,
          boxes: [],
          pending: !plannedRoute,
          plannedRoute,
          labelAtTarget: edge.kind === "case" || edge.kind === "default",
          ...ports,
          compact:
            edge.kind !== "loop" && Math.abs(targetRow - sourceRow) <= 180,
          branch: edge.kind === "true" || edge.kind === "false",
          returning:
            edge.kind === "loop" ||
            (source && target && target.position.y <= source.position.y),
          departure: 18 + (leaving % 3) * 4,
          arrival: 18 + (entering % 3) * 4,
        },
      };
    });
  }, [
    sceneNodes,
    edges,
    selected,
    methodNodes,
    provisional,
    routeScene,
    routing.routes,
  ]);
  const renderedNodes = useMemo(() => {
    const boxes = sceneNodes.map((node) => ({
      id: node.id,
      ...node.position,
      width: node.measured?.width ?? 264,
      height: node.measured?.height ?? 84,
    }));
    const areas: Node<FlowData>[] = loopAreas(methodNodes, boxes).map(
      (area) => ({
        id: area.id,
        type: "loopArea",
        position: { x: area.x, y: area.y },
        style: {
          width: area.width,
          height: area.height,
          pointerEvents: "none",
        },
        width: area.width,
        height: area.height,
        zIndex: -1,
        selectable: false,
        draggable: false,
        focusable: false,
        data: {
          kind: area.kind,
          label: area.members.join(" "),
          line: "",
          selected: false,
          fullLabel: area.id.slice(10),
        },
      }),
    );
    const frames: Node<FlowData>[] = overview
      ? graph.methods.flatMap((m) => {
          const members = boxes.filter(
            (b) => methodNodes.find((n) => n.id === b.id)?.methodId === m.id,
          );
          if (!members.length) return [];
          const x = Math.min(...members.map((b) => b.x)) - 24,
            y = Math.min(...members.map((b) => b.y)) - 18;
          const width = Math.max(...members.map((b) => b.x + b.width)) - x + 24,
            height = Math.max(...members.map((b) => b.y + b.height)) - y + 24;
          return [
            {
              id: "method-area:" + m.id,
              type: "methodArea",
              position: { x, y },
              style: { width, height, pointerEvents: "none" },
              width,
              height,
              zIndex: -2,
              selectable: false,
              draggable: false,
              focusable: false,
              data: {
                kind: "method-area",
                label: m.sourceRange.filePath + " · " + m.signature,
                line: "",
                selected: false,
                groupActive: m.id === methodId,
                fullLabel: m.id,
              },
            },
          ];
        })
      : [];
    return [
      ...frames,
      ...areas,
      ...sceneNodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          dropPosition:
            dropTarget?.highlightId === n.id ? dropTarget.position : undefined,
        },
      })),
    ];
  }, [sceneNodes, methodNodes, dropTarget, overview, graph.methods, methodId]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    viewportWidth.current = element.clientWidth || viewportWidth.current || 500;
    const observer = new ResizeObserver(() => {
      const next = element.clientWidth;
      if (!next) return;
      const width = viewportWidth.current;
      viewportWidth.current = next;
      if (width && next && width !== next && flow.current) {
        const viewport = flow.current.getViewport();
        void flow.current
          .setViewport({
            ...viewport,
            x: viewport.x + (next - width) / 2,
          })
          .then(persistCamera);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const changes = useCallback(
    (c: NodeChange<Node<FlowData>>[]) => {
      const accepted = c.filter(
        (change) =>
          (change.type !== "position" || !provisional) &&
          (!("id" in change) ||
            (!change.id.startsWith("loop-area:") &&
              !change.id.startsWith("method-area:"))),
      );
      if (accepted.length) setNodes((ns) => applyNodeChanges(accepted, ns));
    },
    [provisional],
  );
  async function saveLayout(dragged: Node<FlowData>) {
    if (
      stale ||
      readOnly ||
      provisional ||
      gestureRef.current?.scope !== scopeRef.current ||
      gestureRef.current?.committed
    )
      return;
    gestureRef.current.committed = true;
    const realIds = new Set(methodNodes.map((n) => n.id));
    const finalNodes = (flow.current?.getNodes() ?? nodesRef.current).filter(
      (n) => realIds.has(n.id),
    );
    const current = finalNodes.map((n) =>
      n.id === dragged.id ? { ...n, position: dragged.position } : n,
    );
    nodesRef.current = current;
    setNodes(current);
    if (overview) {
      for (const n of current.filter((n) => n.id === dragged.id || n.selected))
        overviewManualIds.current.add(n.id);
      persistOverview(current);
      return;
    }
    if (!layout) {
      setLayoutError("Координаты ещё загружаются; перемещение не отправлено");
      return;
    }
    const remembered = new Map(manualPositions.current.get(viewKey));
    for (const moved of current.filter(
      (n) => n.id === dragged.id || n.selected,
    )) {
      const key = nodeKeys.get(moved.id);
      if (key) remembered.set(key, { ...moved.position });
    }
    initializedManual.current.add(viewKey);
    manualPositions.current.set(viewKey, remembered);
    try {
      localStorage.setItem(
        `java-blueprints:positions:v2:${viewKey}`,
        JSON.stringify([...remembered]),
      );
    } catch {}
    try {
      const requestedScope = scope;
      const saved = await api<Layout>(
        `${projectPath(projectId)}/revisions/${graph.revisionId}/layout`,
        {
          method: "PUT",
          body: {
            analysisId: graph.analysisId,
            methodId,
            sourceMapVersion: graph.sourceMapVersion,
            layoutVersion: layout.layoutVersion,
            positions: current.map((n) => ({
              nodeId: n.id,
              ...n.position,
            })),
            collapsedNodeIds: layout.collapsedNodeIds,
            viewport: flow.current?.getViewport() ?? layout.viewport,
          },
        },
      );
      if (scopeRef.current !== requestedScope) return;
      setLayout(saved);
      setLayoutError("");
    } catch (e) {
      if (scopeRef.current === scope)
        setLayoutError(e instanceof Error ? e.message : "Ошибка схемы");
    }
  }
  return (
    <div
      className={
        "flow-area" +
        (overview ? " flow-overview" : "") +
        (sceneNodes.length > 100 ? " flow-large" : "") +
        (spacePan ? " space-pan" : "")
      }
      data-graph-view={overview ? "overview" : "method"}
      data-routing-state={
        routing.pending ? "pending" : routing.failed ? "limited" : "ready"
      }
      data-provisional-scene={provisional ? "true" : undefined}
      ref={container}
      onPointerDownCapture={(event) => {
        const target = (event.target as Element).closest(
          ".react-flow__node-blueprint",
        );
        const nodeId = target?.getAttribute("data-id");
        clickSelection.current = nodeId
          ? {
              scope: scopeRef.current,
              nodeId,
              ids: new Set(
                nodesRef.current.filter((n) => n.selected).map((n) => n.id),
              ),
            }
          : null;
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
          setDropTarget(null);
          setHoverKind(null);
        }
      }}
      onDragOver={(e) => {
        if (
          stale ||
          readOnly ||
          !e.dataTransfer.types.includes("application/x-blueprint-block")
        )
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
        setHoverKind(
          (["statement", "condition", "loop"] as const).find((kind) =>
            e.dataTransfer.types.includes(
              "application/x-blueprint-kind-" + kind,
            ),
          ) ?? null,
        );
        // Read the visible scene captured at native drag start. It already
        // includes an existing draft, but subsequent hover reflow cannot move
        // the hit boxes and make a stationary pointer alternate anchors.
        if (hoverScene.current?.scope !== scope)
          hoverScene.current = { scope, nodes: previewHitSnapshot(sceneNodes) };
        const viewport = flow.current?.getViewport();
        const rect = container.current?.getBoundingClientRect();
        const point =
          viewport && rect
            ? {
                x: (e.clientX - rect.left - viewport.x) / viewport.zoom,
                y: (e.clientY - rect.top - viewport.y) / viewport.zoom,
              }
            : null;
        const target = point
          ? baseNodeAt(hoverScene.current.nodes, point)
          : null;
        const n = methodNodes.find((n) => n.id === target?.id);
        const anchor = n
          ? operationAnchor(n, methodNodes, "insert_statement")
          : null;
        if (!target || !n || !anchor) {
          setDropTarget(null);
          return;
        }
        const desired =
          point!.y < target.position.y + (target.measured?.height ?? 84) / 2
            ? "before"
            : "after";
        const position = anchor.insertionPositions?.includes(desired)
          ? desired
          : anchor.insertionPositions?.[0];
        if (!position) {
          setDropTarget(null);
          return;
        }
        e.dataTransfer.dropEffect = "copy";
        setDropTarget((current) =>
          current?.id === anchor.id &&
          current.highlightId === n.id &&
          current.position === position
            ? current
            : { id: anchor.id, highlightId: n.id, position },
        );
      }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData("application/x-blueprint-block");
        const dropAnchor = methodNodes.find((n) => n.id === dropTarget?.id);
        if (
          dropTarget &&
          dropAnchor?.analysisId === graph.analysisId &&
          dropAnchor.revisionId === graph.revisionId &&
          dropAnchor.allowedOperations?.includes("insert_statement") &&
          dropAnchor.insertionPositions?.includes(dropTarget.position) &&
          ["statement", "condition", "loop"].includes(kind) &&
          !stale &&
          !readOnly
        ) {
          e.preventDefault();
          onInsert?.(dropTarget.id, kind, dropTarget.position);
        }
        setDropTarget(null);
        setHoverKind(null);
        hoverScene.current = null;
      }}
    >
      {stale && (
        <div className="stale-banner">
          <span>{staleMessage ?? "Схему нужно обновить"}</span>
          <button disabled={refreshing} onClick={onRefresh}>
            {refreshing ? "Обновление…" : "Обновить схему"}
          </button>
        </div>
      )}
      {(routing.pending || routing.failed) && (
        <span className="graph-routing-status" role="status">
          {routing.pending
            ? "Прокладываем связи…"
            : "Не удалось проложить часть связей"}
        </span>
      )}
      <ReactFlow
        onInit={(instance) => {
          flow.current = instance;
          viewportWidth.current = container.current?.clientWidth || 500;
          void instance.setViewport({
            x: (container.current?.clientWidth || 500) / 2 - 112,
            y: 35,
            zoom: 0.85,
          });
        }}
        nodes={renderedNodes}
        edges={renderedEdges}
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        multiSelectionKeyCode={["Control", "Meta"]}
        selectionKeyCode={["Control", "Shift"]}
        panActivationKeyCode="Space"
        panOnDrag={true}
        noPanClassName={spacePan ? "space-pan-disabled" : "nopan"}
        onSelectionChange={({ nodes: selectedNodes }) => {
          const ids = selectedNodes
            .filter((n) => n.type === "blueprint")
            .map((n) => n.id);
          setMultiSelected((current) =>
            current.length === ids.length &&
            current.every((id, i) => id === ids[i])
              ? current
              : ids,
          );
        }}
        onNodeDragStart={() => {
          gestureRef.current = { scope: scopeRef.current, committed: false };
        }}
        onSelectionDragStart={() => {
          gestureRef.current = { scope: scopeRef.current, committed: false };
        }}
        onNodeDragStop={(_, node) => void saveLayout(node)}
        onSelectionDragStop={(_, selectedNodes) => {
          if (selectedNodes[0]) void saveLayout(selectedNodes[0]);
        }}
        onMoveStart={() => {
          if (nodesRef.current.length > 100)
            container.current
              ?.closest<HTMLElement>(".workbench")
              ?.setAttribute("data-canvas-moving", "true");
        }}
        onMove={(_, viewport) => {
          const element = container.current;
          const level =
            nodesRef.current.length > 100 && viewport.zoom < 0.22
              ? "overview"
              : "full";
          if (element && element.dataset.detailLevel !== level)
            element.dataset.detailLevel = level;
        }}
        onMoveEnd={(event, viewport) => {
          container.current
            ?.closest<HTMLElement>(".workbench")
            ?.removeAttribute("data-canvas-moving");
          // Controls finish programmatic animations too. Ignore only the default
          // viewport before this method's first initialization.
          if (!event && initializedCamera.current !== cameraKeyRef.current)
            return;
          try {
            localStorage.setItem(
              cameraKeyRef.current,
              JSON.stringify(viewport),
            );
            if (overview && !provisional) persistOverview();
          } catch {}
        }}
        onNodeClick={(event, n) => {
          const source = methodNodes.find((s) => s.id === n.id);
          if (!source) return;
          const before = clickSelection.current;
          const ids =
            event.ctrlKey || event.metaKey
              ? new Set(
                  before?.scope === scopeRef.current && before.nodeId === n.id
                    ? before.ids
                    : nodesRef.current
                        .filter((node) => node.selected)
                        .map((node) => node.id),
                )
              : new Set<string>();
          if ((event.ctrlKey || event.metaKey) && ids.has(n.id))
            ids.delete(n.id);
          else ids.add(n.id);
          clickSelection.current = null;
          setNodes((current) =>
            current.map((node) => ({ ...node, selected: ids.has(node.id) })),
          );
          setMultiSelected([...ids]);
          onSelect(source);
        }}
        onNodeDoubleClick={(_, n) => {
          const source = methodNodes.find((s) => s.id === n.id);
          if (source && !stale && !readOnly) onEdit?.(source);
        }}
        nodesDraggable={!provisional && !spacePan && !stale && !readOnly}
        nodesConnectable={false}
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={overview ? 0.03 : 0.15}
        onlyRenderVisibleElements={sceneNodes.length > 1500}
        maxZoom={1.5}
        attributionPosition="bottom-left"
      >
        {provisional && visualPreview && (
          <ViewportPortal>
            <svg className="graph-preview-connectors" aria-hidden="true">
              {provisional.connectors.map((path, i) => (
                <path key={i} d={path} />
              ))}
            </svg>
            <div
              className={"graph-preview preview-" + visualPreview.kind}
              data-flow-preview="true"
              aria-hidden="true"
              style={{
                left: provisional.ghost.x,
                top: provisional.ghost.y,
                minHeight: provisional.ghost.height,
              }}
            >
              <strong>Схема шаблона · код ещё не изменён</strong>
              <div
                className="graph-preview-diagram"
                data-preview-kind={visualPreview.kind}
              >
                <div className={"graph-preview-shape " + visualPreview.kind}>
                  <span>
                    {visualPreview.kind === "condition"
                      ? "Условие"
                      : visualPreview.kind === "loop"
                        ? "Цикл"
                        : "Действие"}
                  </span>
                </div>
                {visualPreview.kind === "condition" && (
                  <div className="graph-preview-branches">
                    <span>
                      да<span className="graph-preview-step">Тело</span>
                    </span>
                    <span>
                      нет<span className="graph-preview-step">Далее</span>
                    </span>
                  </div>
                )}
                {visualPreview.kind === "loop" && (
                  <div className="graph-preview-loop">
                    <span className="graph-preview-step">Тело цикла</span>
                    <span aria-hidden="true">↰ повтор</span>
                  </div>
                )}
              </div>
              <span title={visualPreview.source}>
                {visualPreview.source ??
                  (visualPreview.kind === "condition"
                    ? "if (true) { … }"
                    : visualPreview.kind === "loop"
                      ? "for (…) { … }"
                      : "Действие")}
              </span>
            </div>
          </ViewportPortal>
        )}
        <CanvasBackground />
        <Controls
          showInteractive={false}
          showFitView={false}
          onZoomIn={() => requestAnimationFrame(persistCamera)}
          onZoomOut={() => requestAnimationFrame(persistCamera)}
        >
          <ControlButton
            className="react-flow__controls-fitview"
            onClick={fitCanvas}
            title="Показать всю схему"
            aria-label="Показать всю схему"
          >
            <Maximize2 size={14} />
          </ControlButton>
        </Controls>
      </ReactFlow>
      {multiSelected.length > 1 && (
        <span className="graph-selection-note" role="status">
          Выбрано узлов: {multiSelected.length} · Ctrl — добавить · Space —
          панорама
        </span>
      )}
      {layoutError && (
        <span className="canvas-note" role="status">
          Координаты: {layoutError}
        </span>
      )}
    </div>
  );
}
