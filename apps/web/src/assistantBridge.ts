import type { AssistantCommand } from "./assistantTypes";

export type AssistantResult = { ok: boolean; message: string };
export type AssistantContext = Record<string, unknown>;
export type AssistantWorkspace = {
  context: () => AssistantContext;
  execute: (command: AssistantCommand) => Promise<AssistantResult>;
};
let workspace: AssistantWorkspace | null = null;
let host: ((command: AssistantCommand) => Promise<AssistantResult>) | null =
  null;
let last: AssistantContext = {};
let account: string | undefined;
export function setAssistantAccount(id: string | undefined) {
  if (account !== id) {
    resetAssistantBridge();
    account = id;
  }
}
export function resetAssistantBridge() {
  workspace = null;
  last = {};
}
export function registerAssistantWorkspace(value: AssistantWorkspace) {
  workspace = value;
  return () => {
    if (workspace === value) {
      last = value.context();
      workspace = null;
    }
  };
}
export function registerAssistantHost(value: NonNullable<typeof host>) {
  host = value;
  return () => {
    if (host === value) host = null;
  };
}
export function getAssistantContext(): AssistantContext {
  const current = workspace?.context();
  if (current) last = current;
  return { ...last, ...(current ?? {}), route: location.pathname };
}
export async function executeAssistantCommand(
  command: AssistantCommand,
): Promise<AssistantResult> {
  const actor = account;
  if (["navigate", "set_theme", "guide", "explain"].includes(command.type))
    return host
      ? host(command)
      : { ok: false, message: "Интерфейс ещё загружается. Повторите команду." };
  if (
    ![
      "show_panel",
      "find_symbol",
      "run_tests",
      "run_program",
      "workspace_action",
      "optimize",
    ].includes(command.type)
  )
    return {
      ok: false,
      message:
        "Такое действие выполняется только сервером после подтверждения.",
    };
  const project = command.args.projectId ?? last.projectId;
  if (
    !workspace &&
    typeof project === "string" &&
    /^[\da-f-]{36}$/i.test(project)
  ) {
    history.pushState({}, "", `/projects/${project}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    const end = Date.now() + 12000;
    while (!workspace && actor === account && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (actor !== account)
    return {
      ok: false,
      message: "Аккаунт изменился. Повторите команду в текущем аккаунте.",
    };
  if (workspace && project && workspace.context().projectId !== project)
    return {
      ok: false,
      message: "Открыт другой проект. Запросите действие снова.",
    };
  return workspace
    ? workspace.execute(command)
    : { ok: false, message: "Сначала откройте проект и выберите файл." };
}
