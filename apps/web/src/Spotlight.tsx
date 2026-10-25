import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccount } from "./Account";
import "./spotlight.css";
type Step = {
  target: string;
  title: string;
  text: string;
  panel?: "project" | "graph" | "palette" | "code" | "tests";
};
const work: Step[] = [
  {
    target: '[data-tile-panel="project"]',
    panel: "project",
    title: "Файлы проекта",
    text: "Импортируйте ZIP, папку или GitHub. Нажмите файл для общего обзора, метод — для отдельной схемы.",
  },
  {
    target: ".project-command-search",
    panel: "project",
    title: "Найти в проекте",
    text: "Ищите по коду, именам или словам «условие», «цикл», «метод». Enter открывает результат.",
  },
  {
    target: "[data-graph-aperture]",
    panel: "graph",
    title: "Схема и код",
    text: "Выберите блок для редактирования. Двойной клик открывает его поля. Ctrl-клик выделяет группу.",
  },
  {
    target: '[data-tile-panel="palette"]',
    panel: "palette",
    title: "Добавить блок",
    text: "Откройте палитру и перетащите оператор, условие или цикл в разрешённое место схемы.",
  },
  {
    target: '[data-tile-panel="code"]',
    panel: "code",
    title: "Редактор",
    text: "Код и схема связаны. Ctrl+S сохраняет весь файл и обновляет анализ; автосохранение работает после паузы.",
  },
  {
    target: ".dock-run-control",
    title: "Запуск",
    text: "Выберите класс с main, задайте ввод и аргументы. Ответы Scanner отправляйте в консоли. Квадрат останавливает запуск.",
  },
  {
    target: '[data-tile-panel="tests"]',
    panel: "tests",
    title: "Проверить изменения",
    text: "Сравните две версии на одинаковых входах. Подготовленное изменение сначала покажет diff и пройдёт проверки.",
  },
  {
    target: '.workspace-dock [title="Окна"]',
    title: "Ваше рабочее место",
    text: "Открывайте и скрывайте панели. Перетаскивайте за шесть точек, меняйте размеры — расположение и история сохраняются.",
  },
  {
    target: ".local-presence",
    title: "Профиль и настройки",
    text: "Оформление, друзья, безопасность и GitHub находятся в отдельных разделах настроек. Знакомство можно повторить.",
  },
];
const home: Step[] = [
  {
    target: ".project-heading",
    title: "Начните с проекта",
    text: "Создайте пустой проект, откройте пример или импортируйте свои файлы.",
  },
  {
    target: ".project-list",
    title: "Рабочее пространство",
    text: "Откройте проект, чтобы перейти к Java-коду и интерактивным схемам. В редакторе знакомство продолжится.",
  },
  {
    target: ".account-nav",
    title: "Ваш аккаунт",
    text: "Настройте профиль, внешний вид, друзей и интеграции. Здесь же можно повторить знакомство.",
  },
];
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
    const update = () => {
      if (!target.isConnected) {
        onClose();
        return;
      }
      setRect(target.getBoundingClientRect());
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
  const scope = path.startsWith("/projects/")
    ? "workspace"
    : path.startsWith("/settings")
      ? "settings"
      : path.startsWith("/u/")
        ? "profile"
        : "home";
  const key = "java-blueprints:onboarding:v1:" + user + ":" + scope;
  const [active, setActive] = useState(false),
    [index, setIndex] = useState(0),
    [rect, setRect] = useState<DOMRect | null>(null),
    [unavailable, setUnavailable] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null),
    dialog = useRef<HTMLDivElement>(null);
  const steps =
    scope === "workspace"
      ? work
      : scope === "home"
        ? home
        : [
            {
              target: ".product-sidebar",
              title: "Ваше пространство",
              text: "Профиль, безопасность, темы, друзья и интеграции всегда доступны в боковой панели.",
            },
            {
              target: ".product-content",
              title: "Настройте под себя",
              text: "Изменения профиля и внешнего вида сохраняются в ваших настройках. Публичные и приватные проекты учитывают права доступа.",
            },
          ];
  // Route scope changes before the effect resets the previous tour's index.
  const displayIndex = Math.min(index, steps.length - 1);
  function finish() {
    try {
      localStorage.setItem(key, "done");
    } catch {}
    setActive(false);
    const restore = previousFocus.current;
    requestAnimationFrame(() => {
      if (restore?.isConnected) restore.focus();
    });
  }
  useEffect(() => {
    if (!user || path.includes("login")) {
      setActive(false);
      return;
    }
    let done = true;
    try {
      done = localStorage.getItem(key) === "done";
    } catch {}
    if (!done) {
      previousFocus.current = document.activeElement as HTMLElement;
      setIndex(0);
      setActive(true);
    } else setActive(false);
  }, [user, key, path]);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [active, key]);
  useEffect(() => {
    const replay = () => {
      if (!user) return;
      previousFocus.current = document.activeElement as HTMLElement;
      setIndex(0);
      setActive(true);
    };
    window.addEventListener("java-blueprints:tour", replay);
    return () => window.removeEventListener("java-blueprints:tour", replay);
  }, [user]);
  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    let scrolled: Element | null = null;
    const step = steps[displayIndex];
    setRect(null);
    setUnavailable(false);
    const reveal = () => {
      if (scope === "workspace" && step.panel)
        window.dispatchEvent(
          new CustomEvent("java-blueprints:tour-reveal", {
            detail: { panel: step.panel },
          }),
        );
    };
    reveal();
    // Also reach workspace listeners mounted later in this React commit.
    const retry = setTimeout(reveal, 100);
    let missingSince: number | null = null;
    const measure = () => {
      const el = Array.from(document.querySelectorAll(step.target)).find(
        (candidate) => {
          const box = candidate.getBoundingClientRect();
          const style = getComputedStyle(candidate);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        },
      );
      if (el && scrolled !== el) {
        el.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "instant",
        });
        scrolled = el;
      }
      const box = el?.getBoundingClientRect();
      const visible =
        box &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth;
      setRect((old) => {
        const next = visible ? box : null;
        return old?.x === next?.x &&
          old?.y === next?.y &&
          old?.width === next?.width &&
          old?.height === next?.height
          ? old
          : (next ?? null);
      });
      // Track each consecutive absence, including targets hidden after first render.
      if (visible) {
        missingSince = null;
        setUnavailable(false);
      } else {
        missingSince ??= performance.now();
        setUnavailable(performance.now() - missingSince >= 3000);
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    dialog.current?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !dialog.current?.contains(event.target)
      )
        dialog.current?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      document.removeEventListener("focusin", keepFocus);
    };
  }, [active, displayIndex, scope]);
  if (!active || !user) return null;
  const step = steps[displayIndex],
    left = Math.max(
      16,
      Math.min(innerWidth - 352, rect?.left ?? innerWidth / 2 - 168),
    ),
    top =
      rect && rect.bottom + 180 < innerHeight
        ? rect.bottom + 14
        : Math.max(
            16,
            Math.min(innerHeight - 200, (rect?.top ?? innerHeight / 2) - 195),
          );
  return (
    <div
      className="guided-tour"
      onKeyDownCapture={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish();
        }
        e.stopPropagation();
        if (e.key === "ArrowRight") {
          e.preventDefault();
          if (displayIndex + 1 < steps.length) setIndex(displayIndex + 1);
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setIndex(Math.max(0, displayIndex - 1));
        }
        if (e.key === "Tab") {
          const all = Array.from(
            dialog.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? [],
          );
          const current = all.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            current < 0
              ? e.shiftKey
                ? all.length - 1
                : 0
              : (current + (e.shiftKey ? -1 : 1) + all.length) % all.length;
          e.preventDefault();
          all[next]?.focus();
        }
      }}
    >
      <div className="tour-dimmer" />
      {rect && (
        <div
          className="tour-aperture"
          data-tour-target={step.target}
          aria-hidden="true"
          style={{
            left: rect.left - 5,
            top: rect.top - 5,
            width: rect.width + 10,
            height: rect.height + 10,
          }}
        />
      )}
      <div
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-describedby="tour-step-description"
        aria-label="Знакомство с JavaBlueprints"
        tabIndex={-1}
        ref={dialog}
        style={{ left, top }}
      >
        <small>
          {displayIndex + 1} / {steps.length}
        </small>
        <h3>{step.title}</h3>
        <p id="tour-step-description" aria-live="polite">
          {step.text}
        </p>
        {unavailable && !rect && (
          <p role="status">
            Элемент недоступен в этом представлении. Можно перейти к следующему
            шагу.
          </p>
        )}
        <div>
          <button onClick={finish}>Пропустить</button>
          {displayIndex > 0 && (
            <button onClick={() => setIndex(displayIndex - 1)}>Назад</button>
          )}
          <button
            className="primary"
            onClick={() =>
              displayIndex + 1 < steps.length
                ? setIndex(displayIndex + 1)
                : finish()
            }
          >
            {displayIndex + 1 < steps.length ? "Далее" : "Готово"}
          </button>
        </div>
      </div>
    </div>
  );
}
