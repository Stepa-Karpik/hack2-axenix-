import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { go, useAccount } from "./Account";
import { isSaveShortcut } from "./shortcuts";
import { homeSteps, workspaceSteps, tourSteps } from "./tourSteps";
import { getAssistantContext } from "./assistantBridge";
import type { TourStep } from "./tourSteps";
import type { TourMode } from "./tourSteps";
import { placeTourCard } from "./tourPlacement";
import "./spotlight.css";

export function TargetSpotlight({
  target,
  onClose,
}: {
  target: Element | null;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!target) return;
    let frame = 0;
    const clips: { element: Element; x: boolean; y: boolean }[] = [];
    for (
      let parent = target.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const x = /auto|scroll|hidden|clip/.test(style.overflowX);
      const y = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (x || y) clips.push({ element: parent, x, y });
    }
    const update = () => {
      if (!target.isConnected) {
        onClose();
        return;
      }
      const bounds = target.getBoundingClientRect();
      let left = Math.max(0, bounds.left),
        top = Math.max(0, bounds.top),
        right = Math.min(innerWidth, bounds.right),
        bottom = Math.min(innerHeight, bounds.bottom);
      for (const clip of clips) {
        const parent = clip.element.getBoundingClientRect();
        if (clip.x) {
          left = Math.max(left, parent.left);
          right = Math.min(right, parent.right);
        }
        if (clip.y) {
          top = Math.max(top, parent.top);
          bottom = Math.min(bottom, parent.bottom);
        }
      }
      setRect(
        new DOMRect(
          left,
          top,
          Math.max(0, right - left),
          Math.max(0, bottom - top),
        ),
      );
      frame = requestAnimationFrame(update);
    };
    update();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", escape);
    };
  }, [target, onClose]);
  useEffect(() => {
    const timer = setTimeout(onClose, 4500);
    return () => clearTimeout(timer);
  }, [target, onClose]);
  if (!rect) return null;
  return (
    <div
      className="target-spotlight"
      style={{
        left: rect.left - 5,
        top: rect.top - 5,
        width: rect.width + 10,
        height: rect.height + 10,
      }}
      aria-hidden="true"
    />
  );
}
export default function GuidedTour({ path }: { path: string }) {
  const { session } = useAccount();
  const user = session?.user?.id;
  const [active, setActive] = useState(false);
  const [customSteps, setCustomSteps] = useState<TourStep[] | null>(null);
  const [completion, setCompletion] = useState("");
  const baselineJob = useRef<string>("");
  const [mode, setMode] = useState<TourMode>("full");
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 336, height: 280 });
  const [viewport, setViewport] = useState({
    width: innerWidth,
    height: innerHeight,
  });
  const target = useRef<Element | null>(null),
    dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null),
    claimed = useRef(false);
  const steps = useMemo(
    () => customSteps ?? tourSteps(mode),
    [mode, customSteps],
  );
  const displayIndex = Math.min(index, steps.length - 1);
  const step = steps[displayIndex];
  function finish() {
    try {
      if (!customSteps)
        localStorage.setItem(
          `java-blueprints:onboarding:v2:${user}:${mode}`,
          "done",
        );
    } catch {}
    setActive(false);
    requestAnimationFrame(() => {
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    });
  }
  function advance() {
    if (claimed.current) return;
    claimed.current = true;
    if (displayIndex + 1 < steps.length) setIndex(displayIndex + 1);
    else finish();
  }
  useEffect(() => {
    if (!user) {
      setActive(false);
      return;
    }
    let seen = true;
    try {
      seen =
        localStorage.getItem(`java-blueprints:onboarding:v2:${user}:full`) ===
          "done" ||
        ["home", "workspace", "settings", "profile"].some(
          (scope) =>
            localStorage.getItem(
              `java-blueprints:onboarding:v1:${user}:${scope}`,
            ) === "done",
        );
    } catch {}
    if (!seen) {
      previousFocus.current = document.activeElement as HTMLElement;
      setMode("full");
      setIndex(
        path.startsWith("/projects/")
          ? homeSteps.length
          : path === "/projects"
            ? 0
            : homeSteps.length + workspaceSteps.length,
      );
      setActive(true);
    }
  }, [user]);
  useEffect(() => {
    const replay = (event: Event) => {
      if (!user) return;
      const full = (event as CustomEvent).detail?.mode === "full";
      setCustomSteps(null);
      setCompletion("");
      previousFocus.current = document.activeElement as HTMLElement;
      setMode(
        full ? "full" : path.startsWith("/projects/") ? "workspace" : "account",
      );
      setIndex(0);
      setActive(true);
      if (full && path !== "/projects") go("/projects");
    };
    window.addEventListener("java-blueprints:tour", replay);
    return () => window.removeEventListener("java-blueprints:tour", replay);
  }, [user, path]);
  useEffect(() => {
    const guide = (event: Event) => {
      if (!user) return;
      const steps = (event as CustomEvent<{ steps: TourStep[] }>).detail?.steps;
      if (!Array.isArray(steps) || !steps.length || steps.length > 30) return;
      previousFocus.current = document.activeElement as HTMLElement;
      setCustomSteps(steps);
      setCompletion("");
      setIndex(0);
      setActive(true);
      claimed.current = false;
    };
    window.addEventListener("java-blueprints:assistant-guide", guide);
    return () =>
      window.removeEventListener("java-blueprints:assistant-guide", guide);
  }, [user]);
  useEffect(() => {
    if (!active || step.action !== "wait") return;
    const done = (id: string, status: string, message?: string) => {
      if (
        !id ||
        id === (baselineJob.current || step.afterJobId) ||
        !["succeeded", "failed", "cancelled"].includes(status)
      )
        return;
      setCompletion(
        message ??
          (status === "cancelled"
            ? "Выполнение отменено."
            : status === "failed"
              ? "Выполнение завершилось ошибкой. Откройте диагностику."
              : "Выполнение завершено. Проверьте итог и входные данные в панели."),
      );
      advance();
    };
    const receive = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d?.kind === step.waitFor) done(d.id, d.status, d.message);
    };
    const entered = Date.now();
    const inspect = () => {
      const problem = document.querySelector(
        '.modal[role="dialog"] [role="alert"]',
      );
      const submitting = document.querySelector(
        "[data-assistant-start]:disabled",
      );
      if (problem && !submitting && Date.now() - entered > 400 && customSteps) {
        const retry = customSteps.findIndex((s) => s.id === "assistant-entry");
        if (retry >= 0) setIndex(retry);
        return;
      }
      const el = document.querySelector(step.target);
      if (el)
        done(
          el.getAttribute("data-assistant-job-id") ?? "",
          el.getAttribute("data-assistant-job-status") ?? "",
        );
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-assistant-job-id", "data-assistant-job-status"],
    });
    window.addEventListener("java-blueprints:assistant-job", receive);
    inspect();
    return () => {
      observer.disconnect();
      window.removeEventListener("java-blueprints:assistant-job", receive);
    };
  }, [active, step, customSteps]);
  useLayoutEffect(() => {
    if (!active) return;
    claimed.current = false;
    target.current = null;
    setRect(null);
    setUnavailable(false);
    let frame = 0,
      scrolled: Element | null = null,
      focusedNode: Element | null = null;
    const started = performance.now();
    const reveal = () => {
      if (step.panel)
        window.dispatchEvent(
          new CustomEvent("java-blueprints:tour-reveal", {
            detail: { panel: step.panel },
          }),
        );
    };
    reveal();
    const retry = setTimeout(reveal, 120);
    const measure = () => {
      const candidates = step.target
        .split(",")
        .flatMap((selector) =>
          Array.from(document.querySelectorAll(selector.trim())),
        );
      let found: Element | null = null;
      for (const element of candidates) {
        const box = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        if (
          !box.width ||
          !box.height ||
          style.visibility === "hidden" ||
          style.display === "none" ||
          element.closest("[inert]") ||
          (element as HTMLButtonElement).disabled
        )
          continue;
        if (scrolled !== element) {
          element.scrollIntoView({
            block: "nearest",
            inline: "nearest",
            behavior: "instant",
          });
          scrolled = element;
        }
        const next = element.getBoundingClientRect();
        const x = Math.max(
            1,
            Math.min(innerWidth - 1, next.left + next.width / 2),
          ),
          y = Math.max(
            1,
            Math.min(innerHeight - 1, next.top + next.height / 2),
          );
        const under = document
          .elementsFromPoint(x, y)
          .find((hit) => !hit.closest(".guided-tour"));
        const visible =
          next.left >= 0 &&
          next.top >= 0 &&
          next.right <= innerWidth &&
          next.bottom <= innerHeight &&
          under &&
          (element.contains(under) || under === element);
        if (
          !visible &&
          element.matches(".blueprint-node") &&
          focusedNode !== element
        ) {
          focusedNode = element;
          window.dispatchEvent(
            new CustomEvent("java-blueprints:tour-focus-node", {
              detail: { nodeId: element.getAttribute("data-node-id") },
            }),
          );
        }
        if (visible) {
          found = element;
          break;
        }
      }
      target.current = found;
      const next = found?.getBoundingClientRect() ?? null;
      setRect((old) =>
        old?.x === next?.x &&
        old?.y === next?.y &&
        old?.width === next?.width &&
        old?.height === next?.height
          ? old
          : next,
      );
      setUnavailable(!found && performance.now() - started > 3500);
      frame = requestAnimationFrame(measure);
    };
    measure();
    dialog.current?.focus();
    const keepFocus = (event: FocusEvent) => {
      const el = event.target as Node;
      if (!dialog.current?.contains(el) && !target.current?.contains(el))
        dialog.current?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      document.removeEventListener("focusin", keepFocus);
    };
  }, [active, mode, displayIndex, path, customSteps]);
  useLayoutEffect(() => {
    if (!active || !dialog.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.target.getBoundingClientRect();
      setCardSize((old) =>
        old.width === box.width && old.height === box.height
          ? old
          : { width: box.width, height: box.height },
      );
    });
    observer.observe(dialog.current);
    return () => observer.disconnect();
  }, [active, displayIndex, mode]);
  useEffect(() => {
    const resize = () =>
      setViewport({ width: innerWidth, height: innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!active) return;
    const onAction = (event: Event) => {
      const el = event.target as Element;
      if (
        !target.current ||
        !(el instanceof Element) ||
        !target.current.contains(el)
      )
        return;
      if (step.actionTarget && !el.closest(step.actionTarget)) return;
      if (
        step.action === "input" &&
        (el as HTMLInputElement).value.trim().length < 2
      )
        return;
      if (step.id === "assistant-start") {
        const context = getAssistantContext();
        baselineJob.current = String(
          context[
            customSteps?.some((s) => s.waitFor === "comparison")
              ? "testJobId"
              : "runJobId"
          ] ?? "",
        );
      }
      advance();
    };
    const eventType =
      step.action === "focus"
        ? "focusin"
        : step.action === "input"
          ? "input"
          : "click";
    if (["click", "focus", "input"].includes(step.action))
      document.addEventListener(eventType, onAction, true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish();
        return;
      }
      if (step.action === "download" && !event.repeat && isSaveShortcut(event))
        advance();
      if (event.key === "Tab") {
        const focusable =
          'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';
        const all = [
          ...Array.from(
            target.current?.querySelectorAll<HTMLElement>(focusable) ?? [],
          ),
          ...(target.current?.matches(focusable)
            ? [target.current as HTMLElement]
            : []),
          ...Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? [],
          ),
        ].filter((el) => el.getClientRects().length && !el.closest("[inert]"));
        const current = all.indexOf(document.activeElement as HTMLElement),
          next =
            current < 0
              ? event.shiftKey
                ? all.length - 1
                : 0
              : (current + (event.shiftKey ? -1 : 1) + all.length) % all.length;
        event.preventDefault();
        all[next]?.focus();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener(eventType, onAction, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [active, displayIndex, mode, user, customSteps]);
  if (!active || !user) return null;
  const position = placeTourCard(rect, cardSize, viewport);
  const hole = rect
    ? {
        left: Math.max(0, rect.left - 5),
        top: Math.max(0, rect.top - 5),
        right: Math.min(viewport.width, rect.right + 5),
        bottom: Math.min(viewport.height, rect.bottom + 5),
      }
    : null;
  return (
    <div className="guided-tour" data-tour-step={step.id}>
      {hole ? (
        <>
          <div
            className="tour-shield"
            style={{ left: 0, top: 0, width: viewport.width, height: hole.top }}
          />
          <div
            className="tour-shield"
            style={{
              left: 0,
              top: hole.bottom,
              width: viewport.width,
              height: viewport.height - hole.bottom,
            }}
          />
          <div
            className="tour-shield"
            style={{
              left: 0,
              top: hole.top,
              width: hole.left,
              height: hole.bottom - hole.top,
            }}
          />
          <div
            className="tour-shield"
            style={{
              left: hole.right,
              top: hole.top,
              width: viewport.width - hole.right,
              height: hole.bottom - hole.top,
            }}
          />
          <div
            key={`${mode}:${displayIndex}`}
            className="tour-aperture"
            data-tour-target={step.target}
            aria-hidden="true"
            style={{
              left: hole.left,
              top: hole.top,
              width: hole.right - hole.left,
              height: hole.bottom - hole.top,
            }}
          />
        </>
      ) : (
        <div className="tour-shield tour-waiting" />
      )}
      <div
        key={`${mode}:${displayIndex}`}
        className="tour-card"
        role="dialog"
        aria-modal="false"
        aria-label="Знакомство с JavaBlueprints"
        aria-describedby="tour-step-description"
        tabIndex={-1}
        ref={dialog}
        style={position}
      >
        <div className="tour-card-heading">
          <small>
            {displayIndex + 1} / {steps.length}
          </small>
          <button aria-label="Закрыть обучение" onClick={finish}>
            ×
          </button>
        </div>
        <h3>{step.title}</h3>
        <p id="tour-step-description" aria-live="polite">
          {step.id === "assistant-finished" && completion
            ? completion + " " + step.text
            : step.text}
        </p>
        {unavailable && !rect ? (
          <p className="tour-action-hint" role="status">
            Этот шаг пока недоступен. Можно его пропустить.
          </p>
        ) : (
          step.action !== "inspect" && (
            <p className="tour-action-hint">
              {step.action === "wait"
                ? "Ожидание результата выполнения…"
                : step.action === "download"
                  ? "Нажмите Ctrl+S / ⌘S"
                  : step.action === "input"
                    ? "Введите текст в подсвеченное поле"
                    : step.action === "focus"
                      ? "Нажмите на подсвеченное поле"
                      : "Нажмите на подсвеченный элемент"}
            </p>
          )
        )}
        <div className="tour-card-actions">
          <button onClick={finish}>Завершить</button>
          {step.action === "inspect" ? (
            <button className="primary" onClick={advance}>
              {displayIndex + 1 === steps.length ? "Готово" : "Продолжить"}
            </button>
          ) : (
            <button onClick={advance}>Пропустить шаг</button>
          )}
        </div>
      </div>
    </div>
  );
}
