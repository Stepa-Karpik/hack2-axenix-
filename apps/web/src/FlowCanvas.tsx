import { useEffect, useState, useMemo, useCallback, useRef } from "react";
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
import type { RouteBox } from "./flowLayout";
import type { Graph, GraphNode, Layout, SemanticModel } from "./types";
import {
  arrangeFlow,
  executionNodes,
  routeFlowEdges,
  routeOrthogonal,
  roundedRoute,
  compactFlowLabel,
  dispatchLabelPosition,
  flowLabelTitle,
  loopAreas,
  visualKind,
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
function BlueprintNode({ data }: NodeProps<Node<FlowData>>) {
  const Glyph = nodeIcons[data.visualKind ?? "operation"];
  return (
    <div
      data-insert-position={data.dropPosition}
      data-node-kind={data.kind}
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
      <Handle type="target" position={Position.Top} isConnectable={false} />
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
      <Handle
        id="next"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
      />
      {data.branch && (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Bottom}
            isConnectable={false}
          />
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            isConnectable={false}
          />
          <span className="graph-port graph-port-true" aria-hidden="true">
            да
          </span>
          <span className="graph-port graph-port-false" aria-hidden="true">
            нет
          </span>
        </>
      )}
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
        opaque: "Составной блок",
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
    sourceSide?: "bottom" | "right";
    branch?: boolean;
    returning?: boolean;
    departure?: number;
    arrival?: number;
    highlighted?: boolean;
  }>
>) {
  const routeX = data!.routeX;
  const route = useMemo(
    () =>
      routeOrthogonal(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        routeX,
        data!.boxes,
        data?.departure ?? 22,
        data?.sourceSide,
        data?.arrival ?? 22,
      ),
    [sourceX, sourceY, targetX, targetY, routeX, data],
  );
  const path = roundedRoute(route.points, 16, data?.boxes ?? []);
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
  const labelX = data?.labelAtTarget
    ? targetLabel.x
    : labelStart.x +
      Math.sign(labelEnd.x - labelStart.x) *
        Math.min(48, Math.abs(labelEnd.x - labelStart.x) / 2);
  const labelY = data?.labelAtTarget ? targetLabel.y : labelStart.y;
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
        data-route-returning={data?.returning || undefined}
      >
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
      {label && !data?.branch && (
        <EdgeLabelRenderer>
          <span
            className="shortcut-label"
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
const nodeTypes = { blueprint: BlueprintNode, loopArea: LoopAreaNode };
export default function FlowCanvas({
  graph,
  methodId,
  selected,
  onSelect,
  projectId,
  stale,
  semantics,
  staleMessage,
  onRefresh,
  refreshing,
  onInsert,
  onEdit,
}: {
  graph: Graph;
  methodId: string;
  selected?: string;
  onSelect: (node: GraphNode) => void;
  projectId: string;
  stale: boolean;
  staleMessage?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  onInsert?: (nodeId: string, kind: string, position: string) => void;
  onEdit?: (node: GraphNode) => void;
  semantics?: SemanticModel | null;
}) {
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    highlightId: string;
    position: string;
  } | null>(null);
  const [nodes, setNodes] = useState<Node<FlowData>[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutError, setLayoutError] = useState("");
  const semanticsRef = useRef(semantics);
  semanticsRef.current = semantics;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const flow = useRef<Pick<
    ReactFlowInstance<Node<FlowData>>,
    "setViewport" | "getViewport"
  > | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewportWidth = useRef(0);
  const cameraKey = `java-blueprints:camera:v2:${projectId}:${graph.revisionId}:${graph.analysisId}:${methodId}`;
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
      0.15,
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

  const scope = `${projectId}/${graph.revisionId}/${graph.analysisId}/${methodId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    scopeRef.current = scope;
    return () => {
      if (scopeRef.current === scope) scopeRef.current = "";
    };
  }, [scope]);
  const methodNodes = useMemo(
    () => graph.nodes.filter((n) => n.methodId === methodId),
    [graph, methodId],
  );
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
          data: { fullLabel: e.label ?? undefined },
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
  }, [projectId, graph, methodId]);
  useEffect(() => {
    const visible = executionNodes(methodNodes, edges);
    const positions = arrangeFlow(visible, edges, methodNodes);
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
    setNodes(
      visible.map((n, i) => {
        const pos = layout?.positions.find((p) => p.nodeId === n.id) ??
          positions.get(n.id) ?? { x: 300, y: i * 135 };
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
                  : n.executionRole === "structural"
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
        if (scopeRef.current !== scope) return;
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
        if (camera) void flow.current?.setViewport(camera);
        else if (layout?.positions.length)
          void flow.current?.setViewport(layout.viewport);
        else {
          const entry = visible.find((node) => node.kind === "entry");
          const entryPosition = entry ? positions.get(entry.id) : undefined;
          const area = safeArea();
          void flow.current?.setViewport({
            x: area.x + area.width / 2 - ((entryPosition?.x ?? 0) + 132) * 0.85,
            y: area.y + 120 - (entryPosition?.y ?? 0) * 0.85,
            zoom: 0.85,
          });
        }
      }),
    );
  }, [methodNodes, edges, layout]);
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
  const renderedEdges = useMemo(() => {
    const routes = routeFlowEdges(nodes, edges);
    const boxes = nodes.map((node) => ({
      id: node.id,
      ...node.position,
      width: node.measured?.width ?? 264,
      height: node.measured?.height ?? 84,
    }));
    const departures = new Map<number, number>();
    const arrivals = new Map<number, number>();
    return edges.map((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      const sourceRow = source?.position.y ?? 0,
        targetRow = target?.position.y ?? 0;
      const leaving = departures.get(sourceRow) ?? 0,
        entering = arrivals.get(targetRow) ?? 0;
      departures.set(sourceRow, leaving + 1);
      arrivals.set(targetRow, entering + 1);
      const kind = source?.data.visualKind;
      const color =
        kind === "return"
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
        style: { ...edge.style, stroke: color },
        markerEnd: { ...edge.markerEnd, color },
        type: "shortcut",
        data: {
          ...edge.data,
          highlighted: selected
            ? edge.source === selected || edge.target === selected
            : ["normal", "next", "true"].includes(edge.kind),
          routeX:
            routes.get(edge.id) ??
            ((source?.position.x ?? 0) + (target?.position.x ?? 0)) / 2 + 132,
          boxes,
          labelAtTarget: edge.kind === "case" || edge.kind === "default",
          sourceSide: edge.kind === "false" ? "right" : "bottom",
          branch: edge.kind === "true" || edge.kind === "false",
          returning:
            edge.kind === "loop" ||
            (source && target && target.position.y <= source.position.y),
          departure: 18 + (leaving % 3) * 4,
          arrival: 18 + (entering % 3) * 4,
        },
      };
    });
  }, [nodes, edges, selected]);
  const renderedNodes = useMemo(() => {
    const boxes = nodes.map((node) => ({
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
    return [
      ...areas,
      ...nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          dropPosition:
            dropTarget?.highlightId === n.id ? dropTarget.position : undefined,
        },
      })),
    ];
  }, [nodes, methodNodes, dropTarget]);
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
        void flow.current.setViewport({
          ...viewport,
          x: viewport.x + (next - width) / 2,
        });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const changes = useCallback(
    (c: NodeChange<Node<FlowData>>[]) =>
      setNodes((ns) =>
        applyNodeChanges(
          c.filter(
            (change) =>
              !("id" in change) || !change.id.startsWith("loop-area:"),
          ),
          ns,
        ),
      ),
    [],
  );
  async function saveLayout() {
    if (!layout || stale) return;
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
            positions: nodes.map((n) => ({ nodeId: n.id, ...n.position })),
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
      className="flow-area"
      ref={container}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node))
          setDropTarget(null);
      }}
      onDragOver={(e) => {
        if (
          stale ||
          !e.dataTransfer.types.includes("application/x-blueprint-block")
        )
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "none";
        const target = (e.target as Element).closest(
          ".react-flow__node-blueprint",
        );
        const n = methodNodes.find(
          (n) => n.id === target?.getAttribute("data-id"),
        );
        const anchor = n
          ? operationAnchor(n, methodNodes, "insert_statement")
          : null;
        if (!target || !n || !anchor) {
          setDropTarget(null);
          return;
        }
        const rect = target.getBoundingClientRect();
        const desired =
          e.clientY < rect.top + rect.height / 2 ? "before" : "after";
        const position = anchor.insertionPositions?.includes(desired)
          ? desired
          : anchor.insertionPositions?.[0];
        if (!position) {
          setDropTarget(null);
          return;
        }
        e.dataTransfer.dropEffect = "copy";
        setDropTarget({ id: anchor.id, highlightId: n.id, position });
      }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData("application/x-blueprint-block");
        if (
          dropTarget &&
          ["statement", "condition", "loop"].includes(kind) &&
          !stale
        ) {
          e.preventDefault();
          onInsert?.(dropTarget.id, kind, dropTarget.position);
        }
        setDropTarget(null);
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
        onNodeDragStop={() => void saveLayout()}
        onMoveEnd={(event, viewport) => {
          if (!event) return;
          try {
            localStorage.setItem(
              cameraKeyRef.current,
              JSON.stringify(viewport),
            );
          } catch {}
        }}
        onNodeClick={(_, n) => {
          const source = methodNodes.find((s) => s.id === n.id);
          if (source) onSelect(source);
        }}
        onNodeDoubleClick={(_, n) => {
          const source = methodNodes.find((s) => s.id === n.id);
          if (source && !stale) onEdit?.(source);
        }}
        nodesDraggable={!stale}
        nodesConnectable={false}
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.5}
        attributionPosition="bottom-left"
      >
        <Background gap={22} size={1} color="var(--graph-grid, #d8ddcf)" />
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
      {layoutError && (
        <span className="canvas-note" role="status">
          Координаты: {layoutError}
        </span>
      )}
    </div>
  );
}
