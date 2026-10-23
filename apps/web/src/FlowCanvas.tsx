import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
} from "@xyflow/react";
import type {
  Node,
  NodeProps,
  NodeChange,
  ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph, GraphNode, Layout } from "./types";
import { api, projectPath } from "./api";
type FlowData = {
  label: string;
  kind: string;
  line: string;
  selected: boolean;
};
function BlueprintNode({ data }: NodeProps<Node<FlowData>>) {
  return (
    <div
      className={
        "blueprint-node " + (data.selected ? "selected " : "") + data.kind
      }
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-meta">
        <span>{kindName(data.kind)}</span>
        <span>{data.line}</span>
      </div>
      <div className="node-label">{data.label}</div>
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
        IfStmt: "Условие",
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
  const flow = useRef<Pick<ReactFlowInstance, "setViewport"> | null>(null);
  const container = useRef<HTMLDivElement>(null);
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
    () => new Set(methodNodes.map((n) => n.id)),
    [methodNodes],
  );
  const edges = useMemo(
    () =>
      graph.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          ...e,
          label:
            e.label ??
            (e.kind === "true" ? "да" : e.kind === "false" ? "нет" : undefined),
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
    const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
    const visible = methodNodes.filter(
      (n) => connected.has(n.id) || n.kind === "entry" || n.kind === "exit",
    );
    const forward = new Map<string, typeof edges>();
    const seen = new Set<string>();
    const active = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      active.add(id);
      for (const edge of edges.filter((e) => e.source === id)) {
        if (active.has(edge.target)) continue;
        forward.set(id, [...(forward.get(id) ?? []), edge]);
        visit(edge.target);
      }
      active.delete(id);
    };
    const entry = visible.find((n) => n.kind === "entry");
    if (entry) visit(entry.id);
    const positions = new Map<string, { x: number; y: number }>();
    if (entry) positions.set(entry.id, { x: 0, y: 0 });
    for (let pass = 0; pass < visible.length; pass++) {
      let changed = false;
      for (const [id, children] of forward) {
        const source = positions.get(id);
        if (!source) continue;
        children.forEach((edge, index) => {
          const old = positions.get(edge.target);
          const next = {
            x:
              source.x +
              (children.length > 1
                ? (index - (children.length - 1) / 2) * 280
                : 0),
            y: source.y + 135,
          };
          if (!old || old.y < next.y) {
            positions.set(edge.target, next);
            changed = true;
          }
        });
      }
      if (!changed) break;
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
            label:
              n.kind === "entry"
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
      flow.current?.setViewport({
        x: (container.current?.clientWidth ?? 500) / 2 - 90,
        y: 35,
        zoom: 0.85,
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
            viewport: layout.viewport,
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
          void instance.setViewport({
            x: (container.current?.clientWidth ?? 500) / 2 - 90,
            y: 35,
            zoom: 0.85,
          });
        }}
        nodes={nodes}
        edges={edges}
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
