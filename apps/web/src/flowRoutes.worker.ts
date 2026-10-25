import { computeRoutePlan } from "./flowRoutePlan";
import type { RouteScene } from "./flowRoutePlan";

self.onmessage = (event: MessageEvent<RouteScene>) => {
  try {
    self.postMessage({ routes: computeRoutePlan(event.data) });
  } catch {
    self.postMessage({ error: true });
  }
};
