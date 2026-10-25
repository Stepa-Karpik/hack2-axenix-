import AssistantLocator from "./AssistantLocator";
import { useEffect } from "react";
import { useAccount, go } from "./Account";
import { useTheme } from "./theme";
import { AssistantChat } from "./AssistantChat";
import {
  getAssistantContext,
  registerAssistantHost,
  setAssistantAccount,
} from "./assistantBridge";
import {
  assistantGuideSteps,
  assistantLocation,
  explanations,
  isGuideTopic,
} from "./assistantGuides";

export default function AssistantHost() {
  const { session, refresh } = useAccount();
  const { setPreset } = useTheme();
  const user = session?.user;
  setAssistantAccount(user?.id);
  useEffect(
    () =>
      registerAssistantHost(async (command) => {
        if (command.type === "navigate") {
          const routes: Record<string, string> = {
            projects: "/projects",
            profile: "/settings/profile",
            security: "/settings/security",
            appearance: "/settings/appearance",
            friends: "/settings/friends",
            integrations: "/settings/integrations",
          };
          const route = routes[String(command.args.route)];
          if (!route) return { ok: false, message: "Неизвестный раздел." };
          go(route);
          return { ok: true, message: "Открыт раздел: " + command.args.route };
        }
        if (command.type === "set_theme") {
          const preset = String(command.args.preset);
          if (
            ![
              "oled",
              "dark",
              "light",
              "pearl",
              "blue",
              "amber",
              "slate",
            ].includes(preset)
          )
            return { ok: false, message: "Неизвестная тема." };
          setPreset(preset);
          return { ok: true, message: "Тема изменена: " + preset };
        }
        const topic = command.args.topic;
        if (!isGuideTopic(topic))
          return {
            ok: false,
            message: "Для этой задачи пока нет пошагового маршрута.",
          };
        if (command.type === "explain")
          return { ok: true, message: explanations[topic] };
        if (
          command.args.mode !== "walkthrough" ||
          ![
            "tests",
            "run",
            "files",
            "search",
            "profile",
            "appearance",
            "optimization",
          ].includes(topic)
        ) {
          const destination = assistantLocation(topic);
          const context = getAssistantContext();
          let selectors = destination.selectors;
          let choosingProject = false;
          if (destination.route) go(destination.route);
          else if (!/^\/projects\/[\da-f-]{36}/i.test(location.pathname)) {
            const project = context.projectId;
            if (typeof project === "string" && /^[\da-f-]{36}$/i.test(project))
              go(`/projects/${project}`);
            else {
              go("/projects");
              choosingProject = true;
              selectors = [".project-list", ".project-row, .sample-row"];
            }
          }
          const reveal = () => {
            destination.panels.forEach((panel) =>
              window.dispatchEvent(
                new CustomEvent("java-blueprints:tour-reveal", {
                  detail: { panel },
                }),
              ),
            );
            if (destination.tab)
              window.dispatchEvent(
                new CustomEvent("java-blueprints:assistant-analysis-tab", {
                  detail: { tab: destination.tab },
                }),
              );
            if (destination.menu)
              document
                .querySelector(`[data-assistant-menu="${destination.menu}"]`)
                ?.closest("details")
                ?.setAttribute("open", "");
          };
          reveal();
          setTimeout(reveal, 180);
          setTimeout(reveal, 700);
          window.dispatchEvent(
            new CustomEvent("java-blueprints:assistant-minimize"),
          );
          const shown = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 10000);
            window.dispatchEvent(
              new CustomEvent("java-blueprints:assistant-locate", {
                detail: {
                  selectors,
                  onResult: (value: boolean) => {
                    clearTimeout(timeout);
                    resolve(value);
                  },
                },
              }),
            );
          });
          return {
            ok: shown,
            message: choosingProject
              ? "Сначала откройте проект и повторите вопрос — подсвечу нужную кнопку внутри проекта."
              : shown
                ? `Показано: ${destination.label}. ${destination.description}`
                : "Не удалось показать элемент: он недоступен на текущем экране или показ был прерван. Откройте проект и повторите запрос.",
          };
        }
        const context = getAssistantContext();
        const inProject = /^\/projects\/[\da-f-]{36}/i.test(location.pathname);
        if (topic === "profile") go("/settings/profile");
        else if (topic === "appearance") go("/settings/appearance");
        else if (!inProject) go("/projects");
        window.dispatchEvent(
          new CustomEvent("java-blueprints:assistant-minimize"),
        );
        window.dispatchEvent(
          new CustomEvent("java-blueprints:assistant-guide", {
            detail: {
              steps: assistantGuideSteps(
                topic,
                inProject,
                String(
                  topic === "tests"
                    ? (context.testJobId ?? "")
                    : (context.runJobId ?? ""),
                ),
              ),
            },
          }),
        );
        return {
          ok: true,
          message:
            "Открыта пошаговая помощь. Выполняйте подсвеченные действия. Выполнение программы начнётся только после запуска.",
        };
      }),
    [setPreset],
  );
  useEffect(() => {
    const changed = () => {
      void refresh();
      window.dispatchEvent(
        new CustomEvent("java-blueprints:assistant-project-refresh"),
      );
    };
    window.addEventListener(
      "java-blueprints:assistant-server-changed",
      changed,
    );
    return () =>
      window.removeEventListener(
        "java-blueprints:assistant-server-changed",
        changed,
      );
  }, [refresh]);
  if (
    !user ||
    /^\/(?:auth\/)?(?:login|register|forgot-password|reset-password|verify-email)/.test(
      location.pathname,
    ) ||
    location.pathname === "/"
  )
    return null;
  return (
    <>
      <AssistantChat key={user.id} accountId={user.id} />
      <AssistantLocator key={user.id} />
    </>
  );
}
