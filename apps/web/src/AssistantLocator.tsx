import { useEffect, useState } from "react";
import { TargetSpotlight } from "./Spotlight";

export default function AssistantLocator() {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    let generation = 0,
      frame = 0,
      timer: ReturnType<typeof setTimeout>;
    let report: ((shown: boolean) => void) | undefined;
    const clear = () => {
      report?.(false);
      report = undefined;
      generation++;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      setTarget(null);
    };
    const locate = (event: Event) => {
      clear();
      const detail = (
        event as CustomEvent<{
          selectors: string[];
          onResult?: (shown: boolean) => void;
        }>
      ).detail;
      const selectors = detail?.selectors;
      report = detail?.onResult;
      if (
        !Array.isArray(selectors) ||
        !selectors.length ||
        selectors.length > 5
      ) {
        clear();
        return;
      }
      const token = generation;
      let index = 0,
        started = performance.now();
      const next = () => {
        if (token !== generation) return;
        const element = document.querySelector(selectors[index]);
        if (!element || !element.getClientRects().length) {
          if (performance.now() - started < 8000)
            frame = requestAnimationFrame(next);
          else clear();
          return;
        }
        element.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
        });
        setTarget(element);
        if (index === selectors.length - 1) {
          if (element instanceof HTMLElement)
            element.focus({ preventScroll: true });
          frame = requestAnimationFrame(() => {
            report?.(true);
            report = undefined;
          });
          timer = setTimeout(clear, 4500);
        } else {
          index++;
          started = performance.now();
          timer = setTimeout(next, 360);
        }
      };
      next();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("java-blueprints:assistant-locate", locate);
    window.addEventListener("popstate", clear);
    window.addEventListener("pointerdown", clear);
    window.addEventListener("keydown", key);
    return () => {
      clear();
      window.removeEventListener("java-blueprints:assistant-locate", locate);
      window.removeEventListener("popstate", clear);
      window.removeEventListener("pointerdown", clear);
      window.removeEventListener("keydown", key);
    };
  }, []);
  return target ? (
    <div
      className="assistant-locator"
      data-assistant-focus={
        target.getAttribute("data-assistant-target") ?? target.id ?? ""
      }
    >
      <TargetSpotlight target={target} onClose={() => setTarget(null)} />
    </div>
  ) : null;
}
