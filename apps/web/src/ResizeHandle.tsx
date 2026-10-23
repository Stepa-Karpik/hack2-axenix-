import { useRef } from "react";
export default function ResizeHandle({
  orientation,
  value,
  min,
  max,
  onChange,
  label,
}: {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  const drag = useRef<{ at: number; value: number; span: number } | null>(null);
  const bound = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div
      className={orientation === "vertical" ? "split-resizer" : "dock-resizer"}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        drag.current = {
          at: orientation === "vertical" ? e.clientX : e.clientY,
          value,
          span: e.currentTarget.parentElement?.clientWidth ?? 1000,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start)
          onChange(
            bound(
              start.value +
                (orientation === "vertical"
                  ? ((e.clientX - start.at) * 100) / start.span
                  : start.at - e.clientY),
            ),
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        let delta = 0;
        if (orientation === "vertical") {
          if (e.key === "ArrowLeft") delta = -3;
          if (e.key === "ArrowRight") delta = 3;
        } else {
          if (e.key === "ArrowUp") delta = 20;
          if (e.key === "ArrowDown") delta = -20;
        }
        if (delta) {
          e.preventDefault();
          onChange(bound(value + delta));
        }
      }}
    />
  );
}
