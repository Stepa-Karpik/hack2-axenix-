import { useEffect, useMemo, useRef } from "react";
import { useStore, useViewport } from "@xyflow/react";
import { flowPorts, routeOrthogonal, routePort } from "./flowLayout";
import type { RouteBox, RouteSide } from "./flowLayout";
import { overviewDashPattern } from "./flowScene";

type Box = RouteBox & { visualKind?: string; selected?: boolean };
type Link = {
  id: string;
  source: string;
  target: string;
  kind: string;
  style?: { stroke?: string | number; strokeDasharray?: string | number };
  data?: {
    plannedRoute?: { points: { x: number; y: number }[]; complete?: boolean };
    pending?: boolean;
    sourceSide?: RouteSide;
    targetSide?: RouteSide;
    highlighted?: boolean;
    provisional?: boolean;
  };
};

/** Subscribe only to crossing the detail threshold, not to every pan coordinate. */
export function OverviewDetail({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (compact: boolean) => void;
}) {
  const compact = useStore((state) => enabled && state.transform[2] < 0.22);
  useEffect(() => onChange(compact), [compact, onChange]);
  return null;
}

/** Every logical edge and node remains represented; the DOM wrappers still handle selection/drag. */
export function FlowOverview({
  boxes,
  edges,
}: {
  boxes: Box[];
  edges: Link[];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useViewport();
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const scheduleRef = useRef(() => {});
  const paths = useMemo(() => {
    const byId = new Map(boxes.map((box) => [box.id, box]));
    return edges.flatMap((edge) => {
      const source = byId.get(edge.source),
        target = byId.get(edge.target);
      if (!source || !target) return [];
      const ports = flowPorts(source, target, edge.kind);
      const sourceSide = edge.data?.sourceSide ?? ports.sourceSide,
        targetSide = edge.data?.targetSide ?? ports.targetSide;
      const start = routePort(source, sourceSide),
        end = routePort(target, targetSide);
      const points =
        edge.data?.plannedRoute?.points ??
        routeOrthogonal(
          start,
          end,
          (start.x + end.x) / 2,
          [],
          22,
          sourceSide,
          22,
          targetSide,
          true,
        ).points;
      return [{ ...edge, points }];
    });
  }, [boxes, edges]);

  useEffect(() => {
    const element = canvas.current,
      parent = element?.parentElement;
    if (!element || !parent) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = parent.clientWidth,
        height = parent.clientHeight;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      if (
        element.width !== Math.round(width * ratio) ||
        element.height !== Math.round(height * ratio)
      ) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, element.width, element.height);
      const style = getComputedStyle(parent);
      const colors = new Map<string, string>();
      const color = (value: string) => {
        if (!colors.has(value)) {
          const match = /^var\((--[^)]+)\)$/.exec(value);
          colors.set(
            value,
            match
              ? style.getPropertyValue(match[1]).trim() || "#91a39a"
              : value,
          );
        }
        return colors.get(value)!;
      };
      const { x, y, zoom } = viewportRef.current;
      ctx.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * x, ratio * y);
      ctx.lineWidth = 0.8 / zoom;
      for (const edge of paths) {
        if (!edge.points.length) continue;
        ctx.strokeStyle = color(
          String(edge.style?.stroke ?? "var(--graph-green)"),
        );
        ctx.globalAlpha = edge.data?.highlighted ? 0.95 : 0.5;
        ctx.setLineDash(
          overviewDashPattern(
            edge.style?.strokeDasharray,
            !!edge.data?.provisional,
            !!edge.data?.pending || edge.data?.plannedRoute?.complete === false,
            zoom,
          ),
        );
        ctx.beginPath();
        ctx.moveTo(edge.points[0].x, edge.points[0].y);
        for (let i = 1; i < edge.points.length; i++)
          ctx.lineTo(edge.points[i].x, edge.points[i].y);
        ctx.stroke();
        const end = edge.points.at(-1)!,
          previous = edge.points.at(-2);
        if (previous) {
          const dx = end.x - previous.x,
            dy = end.y - previous.y,
            length = Math.hypot(dx, dy);
          if (length) {
            const ux = dx / length,
              uy = dy / length;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.moveTo(end.x, end.y);
            ctx.lineTo(end.x - ux * 8 - uy * 4, end.y - uy * 8 + ux * 4);
            ctx.lineTo(end.x - ux * 8 + uy * 4, end.y - uy * 8 - ux * 4);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      const palette: Record<string, string> = {
        return: "return",
        condition: "yellow",
        loop: "violet",
        jump: "violet",
        variable: "teal",
        call: "blue",
        operation: "blue",
        method: "green",
        terminal: "return",
        structure: "green",
        join: "green",
      };
      const left = -x / zoom,
        top = -y / zoom,
        right = (width - x) / zoom,
        bottom = (height - y) / zoom;
      const surface = color(
        style.getPropertyValue("--theme-surface").trim() || "#101010",
      );
      for (const box of boxes) {
        if (
          box.x + box.width < left ||
          box.x > right ||
          box.y + box.height < top ||
          box.y > bottom
        )
          continue;
        ctx.fillStyle = surface;
        ctx.strokeStyle = color(
          `var(--graph-${palette[box.visualKind ?? "operation"] ?? "green"})`,
        );
        ctx.lineWidth = (box.selected ? 2 : 0.8) / zoom;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.strokeRect(box.x, box.y, box.width, box.height);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(parent);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-preset", "style"],
    });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      theme.disconnect();
    };
  }, [paths, boxes]);
  useEffect(() => scheduleRef.current(), [viewport]);
  return (
    <canvas
      ref={canvas}
      className="flow-overview-canvas"
      aria-hidden="true"
      data-overview-logical-nodes={boxes.length}
      data-overview-logical-edges={edges.length}
    />
  );
}
