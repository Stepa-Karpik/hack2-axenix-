import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
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
import type { RouteBox } from "./flowLayout";
import type { Graph, GraphNode, Layout } from "./types";
import {
  arrangeFlow,
  executionNodes,
  routeFlowEdges,
  routeOrthogonal,
} from "./flowLayout";
import { api, projectPath } from "./api";
type FlowData = {
  label: string;
  kind: string;
  line: string;
  selected: boolean;
  executionRole?: GraphNode["executionRole"];
};
function BlueprintNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div
      className={
        "blueprint-node " +
        (data.selected ? "selected " : "") +
        data.kind +
        " role-" +
        (data.executionRole ?? "unknown")
      }
    >
      <Handle type="target" position={Position.Top} />
      {data.executionRole === "structural" ? (
        <>
          <div className="node-label">{data.label}</div>
          <span className="structural-line">{data.line}</span>
        </>
      ) : (
        <>
          <div className="node-meta">
            <span>{kindName(data.kind)}</span>
            <span>{data.line}</span>
          </div>
          <div className="node-label">{data.label}</div>
        </>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
export function kindName(kind: string) {
  return (
    (
      {
        entry: "Вход",
        exit: "Выход",
        normal_exit: "Завершение",
        exceptional_exit: "Исключение",
        for_init: "Инициализация",
        for_update: "Обновление",
        loop_back: "Повтор цикла",
        IfStmt: "Если",
        condition_test: "Проверка",
        WhileStmt: "Пока",
        ForStmt: "Цикл",
        DoStmt: "Повтор",
        ReturnStmt: "Возврат",
        ExpressionStmt: "Действие",
        VariableDeclarationExpr: "Переменная",
        ThrowStmt: "Исключение",
        BreakStmt: "Выход из цикла",
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
}: EdgeProps<Edge<{ routeX: number; boxes: RouteBox[] }>>) {
  const routeX = data!.routeX;
  const route = useMemo(
    () =>
      routeOrthogonal(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        routeX,
        data!.boxes,
      ),
    [sourceX, sourceY, targetX, targetY, routeX, data],
  );
  const path = route.points
    .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
    .join(" ");
  const horizontal = route.points
    .slice(1)
    .findIndex(
      (point, index) =>
        point.y === route.points[index].y &&
        Math.abs(point.x - route.points[index].x) > 24,
    );
  const labelStart = route.points[Math.max(0, horizontal)],
    labelEnd = route.points[Math.max(1, horizontal + 1)];
  const labelX =
    labelStart.x +
    Math.sign(labelEnd.x - labelStart.x) *
      Math.min(48, Math.abs(labelEnd.x - labelStart.x) / 2);
  const labelY = labelStart.y;
  return (
    <>
      <g
        data-shortcut-source={source}
        data-shortcut-target={target}
        data-route-status={route.complete ? "clear" : "limited"}
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
      {label && (
        <EdgeLabelRenderer>
          <span
            className="shortcut-label"
            title={
              route.complete
                ? undefined
                : "Маршрут ограничен: обход узлов не гарантирован"
            }
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
const nodeTypes = { blueprint: BlueprintNode };
export default function FlowCanvas({
  graph,
  methodId,
  selected,
  onSelect,
  projectId,
  stale,
}: {
  graph: Graph;
  methodId: string;
  selected?: string;
  onSelect: (node: GraphNode) => void;
  projectId: string;
  stale: boolean;
}) {
  const [nodes, setNodes] = useState<Node<FlowData>[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [layoutError, setLayoutError] = useState("");
  const flow = useRef<Pick<
    ReactFlowInstance<Node<FlowData>>,
    "setViewport" | "getViewport"
  > | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewportWidth = useRef(0);
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
                : (e.label ?? undefined),
          markerEnd: { type: MarkerType.ArrowClosed, color: "#9aa18f" },
          style: { stroke: "#aeb6a1", strokeWidth: 1.3 },
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
    const positions = arrangeFlow(visible, edges);
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
            label:
              n.executionRole === "structural"
                ? kindName(n.kind)
                : n.kind === "entry"
                  ? "Начало"
                  : n.kind === "normal_exit"
                    ? "Завершение"
                    : n.kind === "exceptional_exit"
                      ? "Исключение"
                      : n.kind === "loop_back"
                        ? "Повтор цикла"
                        : n.label.split("\n")[0].slice(0, 110),
            line: n.sourceRange ? `L${n.sourceRange.startLine}` : "",
            selected: false,
          },
        };
      }),
    );
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (scopeRef.current !== scope) return;
        viewportWidth.current = container.current?.clientWidth ?? 500;
        if (layout?.positions.length)
          void flow.current?.setViewport(layout.viewport);
        else {
          const entry = visible.find((node) => node.kind === "entry");
          const entryPosition = entry ? positions.get(entry.id) : undefined;
          void flow.current?.setViewport({
            x:
              (container.current?.clientWidth ?? 500) / 2 -
              ((entryPosition?.x ?? 0) + 87) * 0.85,
            y: 35 - (entryPosition?.y ?? 0) * 0.85,
            zoom: 0.85,
          });
        }
      }),
    );
  }, [methodNodes, edges, layout]);
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
      width: node.measured?.width ?? 280,
      height: node.measured?.height ?? 85,
    }));
    return edges.map((edge) =>
      routes.has(edge.id)
        ? {
            ...edge,
            type: "shortcut",
            data: { routeX: routes.get(edge.id)!, boxes },
          }
        : edge,
    );
  }, [nodes, edges]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    viewportWidth.current = element.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = element.clientWidth;
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
      setNodes((ns) => applyNodeChanges(c, ns)),
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
    <div className="flow-area" ref={container}>
      {stale && (
        <div className="stale-banner">
          Схема версии {graph.revisionId.slice(0, 8)} устарела · только просмотр
        </div>
      )}
      <ReactFlow
        onInit={(instance) => {
          flow.current = instance;
          viewportWidth.current = container.current?.clientWidth ?? 500;
          void instance.setViewport({
            x: (container.current?.clientWidth ?? 500) / 2 - 90,
            y: 35,
            zoom: 0.85,
          });
        }}
        nodes={nodes}
        edges={renderedEdges}
        edgeTypes={edgeTypes}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        onNodeDragStop={() => void saveLayout()}
        onNodeClick={(_, n) => {
          const source = methodNodes.find((s) => s.id === n.id);
          if (source) onSelect(source);
        }}
        nodesDraggable={!stale}
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.5}
        attributionPosition="bottom-left"
      >
        <Background gap={22} size={1} color="#d8ddcf" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {layoutError && (
        <span className="canvas-note" role="status">
          Координаты: {layoutError}
        </span>
      )}
    </div>
  );
}
