import { useEffect, useMemo, useRef, useState } from "react";
import {
  GraphHistory,
  graphHistoryShortcut,
  positionsOf,
} from "./graphHistory";
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
} from "@xyflow/react";
import type { Node, NodeChange, ReactFlowInstance } from "@xyflow/react";
import type {
  InitializationOrder,
  InitializationStep,
  InitializerContext,
  InitializerNode,
  SourceRange,
} from "./types";
import "./initializer.css";

const stepKinds: Record<InitializationStep["kind"], string> = {
  field_initializer: "поле",
  static_initializer_block: "static-блок",
  instance_initializer_block: "блок",
  this_call: "делегирует",
  super_call: "родитель",
  implicit_super_call: "родитель",
  constructor_body: "тело",
};
function OrderSteps({
  steps,
  contexts,
  disabled,
  onSelect,
}: {
  steps: InitializationStep[];
  contexts: Map<string, InitializerContext>;
  disabled: boolean;
  onSelect: (context: InitializerContext) => void;
}) {
  return (
    <ol>
      {steps.map((step, index) => {
        const context = step.contextId ? contexts.get(step.contextId) : undefined;
        const text = (
          <>
            <small>{stepKinds[step.kind]}</small> {step.label}
          </>
        );
        return (
          <li key={index} data-init-step={step.kind}>
            {context ? (
              <button disabled={disabled} onClick={() => onSelect(context)}>
                {text}
              </button>
            ) : (
              <span>{text}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
/** Declared JLS order for classes of the current file; not a runtime trace. */
function InitializationOrderView({
  orders,
  contexts,
  disabled,
  onSelect,
}: {
  orders: InitializationOrder[];
  contexts: InitializerContext[];
  disabled: boolean;
  onSelect: (context: InitializerContext) => void;
}) {
  const byId = new Map(contexts.map((context) => [context.id, context]));
  return (
    <details className="initialization-order" data-initialization-order>
      <summary>Порядок выполнения</summary>
      {orders.map((order) => (
        <div key={order.typeDeclarationId} data-init-type={order.typeName}>
          <h4>{order.typeName}</h4>
          {order.staticPhase.length > 0 && (
            <>
              <p>Один раз, при первом использовании класса:</p>
              <OrderSteps
                steps={order.staticPhase}
                contexts={byId}
                disabled={disabled}
                onSelect={onSelect}
              />
            </>
          )}
          {order.constructors.map((constructor, index) => (
            <div key={constructor.methodId ?? index}>
              <p>
                new {constructor.label}
                {constructor.implicitDefault ? " — конструктор по умолчанию" : ""}
                {constructor.delegation === "this"
                  ? " — инициализаторы выполнит вызванный конструктор"
                  : ""}
                :
              </p>
              <OrderSteps
                steps={constructor.steps}
                contexts={byId}
                disabled={disabled}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      ))}
      <p className="initialization-order-scope">
        Порядок по исходному коду этого класса. Инициализация родительских
        классов, момент загрузки и исключения не моделируются.
      </p>
    </details>
  );
}
export function InitializerList({
  contexts,
  orders = [],
  selected,
  disabled,
  onSelect,
}: {
  contexts: InitializerContext[];
  orders?: InitializationOrder[];
  selected: string;
  disabled: boolean;
  onSelect: (context: InitializerContext) => void;
}) {
  if (!contexts.length) return null;
  return (
    <section className="initializer-list" aria-label="Инициализаторы файла">
      <h3>Инициализация</h3>
      {contexts.map((context) => (
        <button
          key={context.id}
          className={selected === context.id ? "active" : ""}
          data-initializer-id={context.id}
          disabled={disabled}
          onClick={() => onSelect(context)}
        >
          <span aria-hidden="true">{context.effectiveStatic ? "S" : "◇"}</span>{" "}
          {context.label}
        </button>
      ))}
      {orders.length > 0 && (
        <InitializationOrderView
          orders={orders}
          contexts={contexts}
          disabled={disabled}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}

export function InitializerCanvas({
  context,
  selected,
  scope,
  onSelect,
}: {
  context: InitializerContext;
  selected: string;
  scope: string;
  onSelect: (node: InitializerNode) => void;
}) {
  const initial = useMemo(() => {
    const depth = new Map<string, number>();
    return context.nodes.map((node, index) => {
      const level = node.parentId ? (depth.get(node.parentId) ?? 0) + 1 : 0;
      depth.set(node.id, level);
      return {
        id: node.id,
        position: { x: 60 + Math.min(level, 8) * 90, y: 50 + index * 95 },
        data: { label: node.label },
        className: `initializer-node initializer-${node.kind}`,
        style: { width: 270 },
        selected: node.id === selected,
      } as Node;
    });
  }, [context]);
  const [nodes, setNodes] = useState<Node[]>(initial);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<Pick<ReactFlowInstance, "setViewport"> | null>(null);
  const cameraKey = `java-blueprints:initializer-camera:${scope}:${context.id}`;
  function fitCanvas() {
    const instance = flow.current;
    const bounds = container.current?.getBoundingClientRect();
    const aperture = container.current
      ?.closest(".glass-workspace")
      ?.querySelector("[data-graph-aperture]")
      ?.getBoundingClientRect();
    if (!instance || !bounds || !aperture || !initial.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(cameraKey) ?? "null");
      if (
        saved &&
        [saved.x, saved.y, saved.zoom].every(Number.isFinite) &&
        saved.zoom >= 0.1 &&
        saved.zoom <= 2
      ) {
        void instance.setViewport(saved);
        return;
      }
    } catch {}
    const left = Math.min(...initial.map((node) => node.position.x));
    const top = Math.min(...initial.map((node) => node.position.y));
    const right = Math.max(...initial.map((node) => node.position.x + 270));
    const bottom = Math.max(...initial.map((node) => node.position.y + 80));
    const height = Math.max(100, aperture.height - 185);
    const zoom = Math.max(
      0.1,
      Math.min(
        0.9,
        (aperture.width - 60) / (right - left),
        height / (bottom - top),
      ),
    );
    void instance.setViewport({
      x:
        aperture.x -
        bounds.x +
        aperture.width / 2 -
        ((left + right) / 2) * zoom,
      y: aperture.y - bounds.y + 165 + height / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    });
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(fitCanvas));
    return () => cancelAnimationFrame(frame);
  }, [scope, context.id]);
  const history = useRef(new GraphHistory());
  const dragStart = useRef<ReturnType<typeof positionsOf>>([]);
  function remember(current: Node[]) {
    try {
      localStorage.setItem(
        `java-blueprints:initializer:${scope}:${context.id}`,
        JSON.stringify(
          Object.fromEntries(current.map((node) => [node.id, node.position])),
        ),
      );
    } catch {}
  }
  useEffect(() => {
    history.current.clear();
    let positions: Record<string, { x: number; y: number }> = {};
    try {
      positions = JSON.parse(
        localStorage.getItem(
          `java-blueprints:initializer:${scope}:${context.id}`,
        ) ?? "{}",
      );
    } catch {}
    setNodes(
      initial.map((node) => {
        const point = positions[node.id];
        return point && Number.isFinite(point.x) && Number.isFinite(point.y)
          ? { ...node, position: point }
          : node;
      }),
    );
  }, [initial, scope, context.id]);
  const edges = useMemo(
    () =>
      context.edges.map((edge) => ({
        ...edge,
        type: "smoothstep",
        label: "",
        style: { stroke: "var(--muted)", strokeDasharray: "4 4" },
      })),
    [context],
  );
  return (
    <div
      className="initializer-view"
      ref={container}
      data-initializer-context={context.id}
      tabIndex={0}
      onPointerDownCapture={(event) => {
        if (
          !(event.target as Element).closest(
            "button,input,textarea,[contenteditable=true]",
          )
        )
          event.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDownCapture={(event) => {
        if (
          (event.target as Element).closest(
            "input,textarea,[contenteditable=true]",
          )
        )
          return;
        const command = graphHistoryShortcut(event.nativeEvent);
        if (!command) return;
        event.preventDefault();
        event.stopPropagation();
        const snapshot =
          command === "undo"
            ? history.current.undo(positionsOf(nodes))
            : history.current.redo(positionsOf(nodes));
        if (!snapshot) {
          window.dispatchEvent(
            new CustomEvent("java-blueprints:graph-source-history", {
              detail: { command },
            }),
          );
          return;
        }
        const points = new Map(snapshot.map((point) => [point.id, point]));
        const next = nodes.map((node) => {
          const point = points.get(node.id);
          return point
            ? { ...node, position: { x: point.x, y: point.y } }
            : node;
        });
        setNodes(next);
        remember(next);
      }}
    >
      <div className="initializer-caption">
        <strong>{context.label}</strong>
        <span>
          Структура исходника ·{" "}
          {context.effectiveStatic ? "статическая" : "экземпляра"}
        </span>
        <p>
          Пунктир показывает вложенность выражений и операторов. Это не порядок
          исполнения класса.
        </p>
        {context.coverage === "opaque" && context.reason && (
          <p role="status">{context.reason}</p>
        )}
      </div>
      <div className="initializer-flow">
        <ReactFlow
          nodes={nodes.map((n) => ({ ...n, selected: n.id === selected }))}
          edges={edges}
          onInit={(instance) => {
            flow.current = instance;
            requestAnimationFrame(fitCanvas);
          }}
          onMoveEnd={(_, viewport) => {
            try {
              localStorage.setItem(cameraKey, JSON.stringify(viewport));
            } catch {}
          }}
          minZoom={0.1}
          maxZoom={2}
          nodesConnectable={false}
          deleteKeyCode={null}
          onNodesChange={(changes: NodeChange[]) =>
            setNodes((old) => applyNodeChanges(changes, old))
          }
          onNodeClick={(_, node) => {
            const source = context.nodes.find((item) => item.id === node.id);
            if (source) onSelect(source);
          }}
          onNodeDragStart={() => {
            dragStart.current = positionsOf(nodes);
          }}
          onNodeDragStop={(_, dragged) => {
            const next = nodes.map((node) =>
              node.id === dragged.id
                ? { ...node, position: dragged.position }
                : node,
            );
            if (history.current.commit(dragStart.current, positionsOf(next)))
              window.dispatchEvent(
                new CustomEvent("java-blueprints:graph-source-history", {
                  detail: { command: "clear_redo" },
                }),
              );
            setNodes(next);
            remember(next);
          }}
        >
          <Background color="var(--muted)" gap={22} size={0.8} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

export function InitializerInspector({
  context,
  node,
  source,
  disabled,
  onNavigate,
  onPrepare,
}: {
  context: InitializerContext;
  node: InitializerNode | null;
  source: string;
  disabled: boolean;
  onNavigate: (range: SourceRange) => void;
  onPrepare: (
    context: InitializerContext,
    node: InitializerNode,
    source: string,
  ) => Promise<void>;
}) {
  const range = node?.editableFieldRanges.expression ?? node?.sourceRange;
  const original = range
    ? source.slice(range.startOffset, range.endOffset)
    : "";
  const [draft, setDraft] = useState(original);
  useEffect(() => setDraft(original), [original, node?.id]);
  const editable =
    !!node?.allowedOperations.includes("replace_expression") &&
    node.editableFields.includes("expression");
  return (
    <section
      className="initializer-inspector"
      aria-label="Редактирование инициализатора"
    >
      <h3>{context.label}</h3>
      <p className="small quiet">
        {context.sourceRange.filePath} · строка{" "}
        {node?.sourceRange.startLine ?? context.sourceRange.startLine}
      </p>
      <button
        onClick={() => onNavigate(node?.sourceRange ?? context.sourceRange)}
      >
        Перейти к коду
      </button>
      {!node ? (
        <p>Выберите выражение на схеме инициализатора.</p>
      ) : (
        <>
          <pre>{node.label}</pre>
          {editable ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled && draft.trim())
                  void onPrepare(context, node, draft);
              }}
            >
              <label htmlFor="initializer-expression">Выражение Java</label>
              <textarea
                id="initializer-expression"
                value={draft}
                disabled={disabled}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
              />
              <p className="small quiet">
                Создаётся отдельный кандидат. Перед применением доступны
                компиляция, разница и сравнение на тестах.
              </p>
              <button
                className="product-action"
                disabled={disabled || !draft.trim() || draft === original}
              >
                Подготовить изменение
              </button>
            </form>
          ) : (
            <p className="small quiet">
              Этот узел показывает структуру. Для правки выберите вложенное
              разрешённое выражение.
            </p>
          )}
        </>
      )}
    </section>
  );
}
