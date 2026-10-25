import { useEffect, useMemo, useState } from "react";
import { computeRoutePlan } from "./flowRoutePlan";
import type { RouteScene } from "./flowRoutePlan";
const cache = new Map<string, ReturnType<typeof computeRoutePlan>>();

export default function useFlowRoutes(scene: RouteScene) {
  // Selection, editor typing and camera changes do not invalidate geometry.
  const key = JSON.stringify(scene);
  const stableScene = useMemo(() => scene, [key]);
  const background = stableScene.boxes.length > 100;
  const cached = cache.get(key);
  const synchronous = useMemo(
    () => (background ? null : computeRoutePlan(stableScene)),
    [stableScene, background],
  );
  const [result, setResult] = useState<{
    key: string;
    routes: ReturnType<typeof computeRoutePlan> | null;
    error: boolean;
  } | null>(null);
  useEffect(() => {
    if (!background || cached) return;
    let worker: Worker | undefined;
    let active = true;
    const timer = setTimeout(() => {
      try {
        worker = new Worker(
          new URL("./flowRoutes.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (event) => {
          if (active && event.data.routes) {
            cache.set(key, event.data.routes);
            while (cache.size > 8) cache.delete(cache.keys().next().value!);
          }
          if (active)
            setResult({
              key,
              routes: event.data.routes ?? null,
              error: !!event.data.error,
            });
          worker?.terminate();
        };
        worker.onerror = () => {
          if (active) setResult({ key, routes: null, error: true });
          worker?.terminate();
        };
        worker.postMessage(stableScene);
      } catch {
        if (active) setResult({ key, routes: null, error: true });
      }
    }, 30);
    return () => {
      active = false;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [key, stableScene, background, cached]);
  return {
    routes:
      synchronous ?? cached ?? (result?.key === key ? result.routes : null),
    pending: background && !cached && result?.key !== key,
    failed: background && !cached && result?.key === key && result.error,
  };
}
