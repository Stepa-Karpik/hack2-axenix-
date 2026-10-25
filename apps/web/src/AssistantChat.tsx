import { useEffect, useRef, useState } from "react";
import AssistantText from "./AssistantText";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Maximize2,
  Minimize2,
  MessageCircle,
  Minus,
  MoreHorizontal,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { assistantApi } from "./assistantApi";
import { ApiError } from "./api";
import {
  executeAssistantCommand,
  getAssistantContext,
} from "./assistantBridge";
import type {
  AssistantAction,
  AssistantConversation,
  AssistantConversationSummary,
} from "./assistantTypes";
import "./AssistantChat.css";

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
const allowedActions = new Set([
  "navigate",
  "set_theme",
  "show_panel",
  "guide",
  "find_symbol",
  "run_tests",
  "optimize",
  "run_program",
  "workspace_action",
  "set_visibility",
  "pin_project",
  "update_profile",
  "friend_request", "friend_accept", "friend_decline", "friend_remove", "project_role", "code_edit", "layout_action",
  "explain",
]);
const actionLabel = (action: AssistantAction) =>
  action.type === "guide"
    ? "Показать"
    : action.type === "explain"
      ? "Рассказать"
      : action.type === "run_tests"
        ? "Да, запустить тесты"
        : action.label || "Выполнить";

export function AssistantChat({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<"history" | "options" | null>(null);
  const [history, setHistory] = useState<AssistantConversationSummary[]>([]);
  const [conversation, setConversation] =
    useState<AssistantConversation | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [includeSource, setIncludeSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState(false);
  const [notice, setNotice] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionStates, setActionStates] = useState<
    Record<
      string,
      {
        busy?: boolean;
        done?: boolean;
        message?: string;
        error?: boolean;
        retry?: boolean;
      }
    >
  >({});
  const [confirmation, setConfirmation] = useState<Record<string, string>>({});
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const openRef = useRef(false);
  const mounted = useRef(true);
  const attempted = useRef(new Set<string>());
  const actionInFlight = useRef(new Set<string>());
  const historyVersion = useRef(0);
  const interactionBusy =
    busy ||
    loading ||
    deleting ||
    Object.values(actionStates).some((state) => state.busy);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      readRequest.current?.abort();
    };
  }, [accountId]);
  useEffect(() => {
    openRef.current = open;
    if (open) {
      setUnread(false);
      composer.current?.focus();
    }
  }, [open, loading, configured]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [conversation, busy, open]);
  const minimize = () => {
    setOpen(false);
    setMenu(null);
    launcher.current?.focus();
  };
  useEffect(() => {
    const handler = () => minimize();
    window.addEventListener("java-blueprints:assistant-minimize", handler);
    return () =>
      window.removeEventListener("java-blueprints:assistant-minimize", handler);
  }, []);

  async function initialize() {
    if (initialized.current) return;
    initialized.current = true;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const [status, items] = await Promise.all([
        assistantApi.status(controller.signal),
        assistantApi.list(controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setConfigured(status.configured);
      setHistory(items);
      if (items[0]) {
        const saved = await assistantApi.get(items[0].id, controller.signal);
        if (mounted.current && !controller.signal.aborted)
          setConversation(saved);
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        initialized.current = false;
        setError(errorText(e));
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }
  async function selectConversation(id: string) {
    setMenu(null);
    setLoading(true);
    setError("");
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const saved = await assistantApi.get(id, controller.signal);
      if (mounted.current && !controller.signal.aborted) setConversation(saved);
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) setError(errorText(e));
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }
  async function refreshHistory() {
    const version = ++historyVersion.current;
    try {
      const items = await assistantApi.list();
      if (mounted.current && version === historyVersion.current)
        setHistory(items);
    } catch {
      /* The active conversation remains available. */
    }
  }
  async function deleteConversation(id: string) {
    if (interactionBusy) return;
    setDeleting(true);
    setError("");
    ++historyVersion.current;
    try {
      const result = await assistantApi.remove(id);
      if (!mounted.current) return;
      if (!result.deleted)
        throw new Error("Не удалось удалить беседу. Попробуйте ещё раз.");
      setHistory((items) => items.filter((item) => item.id !== id));
      if (conversation?.id === id) {
        setConversation(null);
        setDraft("");
        setNotice("");
      }
      setDeleteId(null);
      void refreshHistory();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  async function runAction(
    action: AssistantAction,
    cid: string,
    typed?: string,
  ) {
    const key = `${cid}:${action.id}`;
    if (
      !allowedActions.has(action.type) ||
      action.status !== "pending" ||
      actionInFlight.current.has(key) ||
      attempted.current.has(key)
    )
      return;
    if (
      ["set_visibility", "project_role"].includes(action.type) &&
      (action.risk !== "typed" || typed !== "да")
    )
      return;
    if (action.risk === "typed" && typed !== "да") return;
    attempted.current.add(key);
    actionInFlight.current.add(key);
    setActionStates((s) => ({ ...s, [key]: { busy: true } }));
    try {
      const response = await assistantApi.act(cid, action.id, typed);
      if (!mounted.current) return;
      let outcome = {
        ok: response.action.status === "completed" || !!response.command,
        message:
          response.action.status === "completed"
            ? "Выполнено"
            : response.action.status === "cancelled"
              ? "Отменено"
              : "Действие уже передано интерфейсу. Повторное выполнение заблокировано; уточните результат или запросите заново.",
      };
      if (response.command) {
        try {
          const command = response.command;
          if (command.type === "guide" && command.args.topic === "profile") {
            const index =
              conversation?.messages.findIndex((message) =>
                message.actions?.some((item) => item.id === action.id),
              ) ?? -1;
            const question =
              conversation?.messages
                .slice(0, index)
                .reverse()
                .find((message) => message.role === "user")?.content ?? "";
            if (/фото|аватар|картин|изображен/i.test(question))
              command.args = { ...command.args, topic: "profile_photo" };
          }
          outcome = await executeAssistantCommand(command);
        } catch (e) {
          outcome = { ok: false, message: errorText(e) };
        }
        try {
          if (!mounted.current) return;
          await assistantApi.result(cid, action.id, outcome);
        } catch (e) {
          outcome = {
            ok: false,
            message: `${outcome.message}. Не удалось сохранить результат: ${errorText(e)}`,
          };
        }
      }
      if (
        mounted.current &&
        outcome.ok &&
        response.action.status === "completed" &&
        ["set_visibility", "pin_project", "update_profile", "friend_request", "friend_accept", "friend_decline", "friend_remove", "project_role"].includes(
          action.type,
        )
      )
        window.dispatchEvent(
          new CustomEvent("java-blueprints:assistant-server-changed", {
            detail: { type: action.type, args: action.args },
          }),
        );
      if (mounted.current)
        setActionStates((s) => ({
          ...s,
          [key]: { done: true, message: outcome.message, error: !outcome.ok },
        }));
    } catch (e) {
      const retry =
        e instanceof ApiError &&
        ["CONFIRMATION_REQUIRED", "OWNER_REQUIRED", "PIN_LIMIT"].includes(
          e.code,
        );
      if (retry) attempted.current.delete(key);
      if (mounted.current)
        setActionStates((s) => ({
          ...s,
          [key]: { done: !retry, retry, message: errorText(e), error: true },
        }));
    } finally {
      actionInFlight.current.delete(key);
    }
  }
  async function cancelAction(action: AssistantAction, cid: string) {
    const key = `${cid}:${action.id}`;
    if (actionInFlight.current.has(key) || attempted.current.has(key)) return;
    actionInFlight.current.add(key);
    attempted.current.add(key);
    setActionStates((s) => ({ ...s, [key]: { busy: true } }));
    try {
      const response = await assistantApi.cancel(cid, action.id);
      if (!mounted.current) return;
      const cancelled = response.action.status === "cancelled";
      setActionStates((s) => ({
        ...s,
        [key]: {
          done: true,
          message: cancelled
            ? "Отменено. Уточните, что нужно сделать."
            : "Действие уже передано на выполнение. Проверьте результат перед новым запросом.",
        },
      }));
      if (cancelled) {
        setDraft((value) => value || "Уточню задачу: ");
        composer.current?.focus();
      }
    } catch (e) {
      if (mounted.current)
        setActionStates((s) => ({
          ...s,
          [key]: { done: true, message: errorText(e), error: true },
        }));
    } finally {
      actionInFlight.current.delete(key);
    }
  }
  async function send() {
    const content = draft.trim();
    if (!content || interactionBusy || configured !== true) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    setDraft("");
    try {
      let current = conversation;
      if (!current) {
        current = await assistantApi.create(controller.signal);
        if (mounted.current && !controller.signal.aborted)
          setConversation(current);
      }
      if (controller.signal.aborted || !mounted.current) return;
      const cid = current.id;
      const previousMessages = new Set(
        current.messages.map((message) => message.id),
      );
      setConversation({
        ...current,
        messages: [
          ...current.messages,
          {
            id: `pending-${crypto.randomUUID()}`,
            role: "user",
            content,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const reply = await assistantApi.send(
        cid,
        content,
        { ...getAssistantContext(), includeSource },
        controller.signal,
      );
      if (controller.signal.aborted || !mounted.current) return;
      setConversation(reply);
      if (!openRef.current) setUnread(true);
      void refreshHistory();
      for (const message of reply.messages) {
        if (message.role !== "assistant" || previousMessages.has(message.id))
          continue;
        for (const action of message.actions ?? []) {
          if (
            action.risk === "none" &&
            action.status === "pending" &&
            !["set_visibility", "guide", "explain"].includes(action.type) &&
            !(
              action.type === "navigate" &&
              message.actions?.some((other) => other.type === "guide")
            )
          )
            void runAction(action, reply.id);
        }
      }
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) {
        setError(errorText(e));
        setDraft(content);
      }
    } finally {
      if (mounted.current && request.current === controller) {
        setBusy(false);
        request.current = null;
      }
    }
  }
  function stop() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setNotice(
      "Ожидание ответа остановлено. Сервер мог сохранить сообщение; откройте беседу из истории, чтобы проверить.",
    );
    void refreshHistory();
  }

  return (
    <div className="assistant-chat-root" data-assistant-chat>
      <button
        ref={launcher}
        className="assistant-launcher"
        aria-label={
          unread
            ? "Открыть беседу — новый ответ"
            : "Открыть беседу с помощником"
        }
        aria-expanded={open}
        aria-controls="assistant-chat-panel"
        onClick={() => {
          if (open) minimize();
          else {
            setOpen(true);
            void initialize();
          }
        }}
      >
        <MessageCircle size={21} strokeWidth={1.6} />
        {unread && <span className="assistant-unread" />}
      </button>
      {open && (
        <section
          ref={panel}
          id="assistant-chat-panel"
          className={`assistant-chat-panel${expanded ? " is-expanded" : ""}`}
          role="dialog"
          aria-label="Помощник — беседа"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              if (menu) setMenu(null);
              else minimize();
            }
            if (event.key === "Tab") {
              const elements = Array.from(
                panel.current?.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), textarea:not(:disabled), input:not(:disabled)",
                ) ?? [],
              ).filter((el) => el.getClientRects().length);
              const first = elements[0],
                last = elements.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <header className="assistant-header">
            <button
              className="assistant-title"
              aria-expanded={menu === "history"}
              onClick={() => {
                setMenu(menu === "history" ? null : "history");
                void refreshHistory();
              }}
            >
              <MessageCircle size={16} /> Беседа <ChevronDown size={13} />
            </button>
            <div className="assistant-header-tools">
              <button
                aria-label={
                  expanded ? "Компактный вид беседы" : "Развернуть беседу"
                }
                title={expanded ? "Компактный вид" : "Развернуть"}
                aria-pressed={expanded}
                onClick={() => {
                  setExpanded((value) => !value);
                  setMenu(null);
                }}
              >
                {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                aria-label="Настройки беседы"
                aria-expanded={menu === "options"}
                onClick={() => setMenu(menu === "options" ? null : "options")}
              >
                <MoreHorizontal size={19} />
              </button>
              <button aria-label="Закрыть беседу" onClick={minimize}>
                <X size={17} />
              </button>
            </div>
          </header>
          {menu === "history" && (
            <nav
              className="assistant-dropdown assistant-history"
              aria-label="История бесед"
            >
              <button
                disabled={interactionBusy}
                onClick={() => {
                  setConversation(null);
                  setDraft("");
                  setError("");
                  setNotice("");
                  setDeleteId(null);
                  setMenu(null);
                  composer.current?.focus();
                }}
              >
                <Plus size={15} /> Новая беседа
              </button>
              {history.length === 0 && <p>Здесь появятся ваши беседы</p>}
              {history.map((item) => (
                <div className="assistant-history-row" key={item.id}>
                  <button
                    disabled={interactionBusy}
                    aria-current={
                      conversation?.id === item.id ? "true" : undefined
                    }
                    onClick={() => {
                      setDeleteId(null);
                      void selectConversation(item.id);
                    }}
                  >
                    <span>{item.title || "Беседа"}</span>
                    <time>
                      {new Date(item.updatedAt).toLocaleDateString("ru-RU")}
                    </time>
                  </button>
                  <button
                    className="assistant-history-delete"
                    disabled={interactionBusy}
                    aria-label={`Удалить беседу «${item.title || "Беседа"}»`}
                    onClick={() =>
                      setDeleteId(deleteId === item.id ? null : item.id)
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                  {deleteId === item.id && (
                    <div
                      className="assistant-history-confirm"
                      role="group"
                      aria-label={`Удаление беседы «${item.title || "Беседа"}»`}
                    >
                      <p>Удалить эту беседу из истории? Проекты сохранятся.</p>
                      <div>
                        <button
                          disabled={deleting}
                          onClick={() => void deleteConversation(item.id)}
                        >
                          {deleting ? "Удаляем…" : "Удалить беседу"}
                        </button>
                        <button
                          disabled={deleting}
                          onClick={() => setDeleteId(null)}
                        >
                          Оставить
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </nav>
          )}
          {menu === "options" && (
            <nav
              className="assistant-dropdown assistant-options"
              aria-label="Размер беседы"
            >
              <button onClick={minimize}>
                <Minus size={15} /> Свернуть
              </button>
              <button
                onClick={() => {
                  setExpanded(false);
                  setMenu(null);
                }}
              >
                <MessageCircle size={15} /> Компактный вид{" "}
                {!expanded && <Check size={14} />}
              </button>
              <button
                onClick={() => {
                  setExpanded(true);
                  setMenu(null);
                }}
              >
                <Maximize2 size={15} /> Развернуть{" "}
                {expanded && <Check size={14} />}
              </button>
            </nav>
          )}
          <div
            className="assistant-messages"
            role="log"
            aria-label="Сообщения беседы"
            aria-live="polite"
            aria-relevant="additions text"
            aria-busy={busy || loading}
          >
            {loading && <p className="assistant-empty">Загружаем беседу…</p>}
            {!loading && !conversation?.messages.length && (
              <div className="assistant-welcome">
                <MessageCircle size={28} strokeWidth={1.25} />
                <h2>Чем помочь?</h2>
                <p>
                  Спросите о проекте или попросите показать нужное действие.
                </p>
                <div className="assistant-suggestions">
                  {["Что умеет помощник?", "Покажи, как запустить тесты"].map(
                    (text) => (
                      <button
                        key={text}
                        onClick={() => {
                          setDraft(text);
                          composer.current?.focus();
                        }}
                      >
                        {text}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}
            {conversation?.messages.map((message) => (
              <article
                key={message.id}
                className={`assistant-message assistant-message-${message.role}`}
              >
                <span className="assistant-speaker">
                  {message.role === "user" ? "Вы" : "Помощник"}
                </span>
                <div className="assistant-message-content">
                  {message.role === "assistant" ? (
                    <AssistantText text={message.content} />
                  ) : (
                    message.content
                  )}
                </div>
                {message.role === "assistant" &&
                  message.actions?.map((action) => {
                    const key = `${conversation.id}:${action.id}`,
                      state = actionStates[key];
                    const safe =
                      allowedActions.has(action.type) &&
                      ["none", "confirm", "typed"].includes(action.risk) &&
                      (action.risk !== "typed" ||
                        ["set_visibility", "project_role"].includes(action.type)) &&
                      (!["set_visibility", "project_role"].includes(action.type) ||
                        action.risk === "typed");
                    const done = action.status !== "pending" || state?.done;
                    if (action.type === "navigate")
                      return message.actions?.some(
                        (other) => other.type === "guide",
                      ) || !state?.message ? null : (
                        <p key={action.id} role="status">
                          {state.message}
                        </p>
                      );
                    const hint = ["guide", "explain"].includes(action.type);
                    return (
                      <div
                        className={
                          hint
                            ? "assistant-action assistant-hint-action"
                            : "assistant-action"
                        }
                        key={action.id}
                      >
                        {!hint && (
                          <>
                            <strong>{action.label}</strong>
                            <p>{action.description}</p>
                          </>
                        )}
                        {action.type === "set_visibility" && (
                          <p>
                            Проект:{" "}
                            {typeof action.args.projectId === "string"
                              ? action.args.projectId
                              : "не указан"}
                            . Видимость:{" "}
                            {action.args.visibility === "public"
                              ? "публичная"
                              : action.args.visibility === "private"
                                ? "приватная"
                                : "не указана"}
                            .
                          </p>
                        )}
                        {!safe && <span>Это действие недоступно.</span>}
                        {action.type === "code_edit" && (
                          <details>
                            <summary>Предлагаемый фрагмент · {String(action.args.filePath ?? "")}</summary>
                            <p>Было:</p><pre>{String(action.args.expectedText ?? "")}</pre>
                            <p>Станет:</p><pre>{String(action.args.replacement ?? "")}</pre>
                          </details>
                        )}
                        {safe && !done && action.risk === "typed" && (
                          <label className="assistant-confirm-label">
                            {action.type === "set_visibility"
                              ? "Изменение видимости проекта меняет доступ к исходному коду. Проверьте выбранный проект и запрошенную видимость выше. Для подтверждения введите «да»."
                              : "Для подтверждения этого действия введите «да»."}
                            <input
                              aria-label={`Подтверждение: ${action.label}`}
                              autoComplete="off"
                              value={confirmation[key] ?? ""}
                              onChange={(e) =>
                                setConfirmation((s) => ({
                                  ...s,
                                  [key]: e.target.value,
                                }))
                              }
                            />
                          </label>
                        )}
                        {safe && !done && (
                          <button
                            disabled={
                              state?.busy ||
                              (action.risk === "typed" &&
                                confirmation[key] !== "да")
                            }
                            onClick={() =>
                              void runAction(
                                action,
                                conversation.id,
                                action.risk === "typed"
                                  ? confirmation[key]
                                  : undefined,
                              )
                            }
                          >
                            {state?.busy
                              ? "Выполняем…"
                              : state?.retry
                                ? "Повторить"
                                : actionLabel(action)}
                          </button>
                        )}
                        {safe &&
                          !done &&
                          ["confirm", "typed"].includes(action.risk) &&
                          !["guide", "explain"].includes(action.type) && (
                            <button
                              disabled={state?.busy}
                              onClick={() =>
                                void cancelAction(action, conversation.id)
                              }
                            >
                              {action.type === "run_tests"
                                ? "Нет, уточнить"
                                : "Отменить"}
                            </button>
                          )}
                        {(done || state?.message) && (
                          <span
                            role={state?.error ? "alert" : "status"}
                            className={
                              state?.error ? "assistant-action-error" : ""
                            }
                          >
                            {state?.message ||
                              (action.status === "cancelled"
                                ? "Отменено"
                                : "Выполнено")}
                          </span>
                        )}
                      </div>
                    );
                  })}
              </article>
            ))}
            {busy && (
              <p className="assistant-thinking">
                Помощник отвечает<span aria-hidden="true">…</span>
              </p>
            )}
            <div ref={end} />
          </div>
          {error && (
            <div className="assistant-error" role="alert">
              {error}
              {!initialized.current && (
                <button onClick={() => void initialize()}>Повторить</button>
              )}
            </div>
          )}
          {notice && (
            <p className="assistant-notice" role="status">
              {notice}
            </p>
          )}
          {configured === false && (
            <p className="assistant-notice">
              Помощник пока не подключён. Администратору нужно настроить
              DeepSeek на сервере.
            </p>
          )}
          <form
            className="assistant-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="assistant-source-consent">
              <input type="checkbox" checked={includeSource} disabled={interactionBusy}
                onChange={(event) => setIncludeSource(event.target.checked)} />
              Передать DeepSeek сохранённый Java-файл (до 12 000 символов); для большого файла — выбранный метод. Для подготовки правки
            </label>
            <textarea
              ref={composer}
              aria-label="Сообщение помощнику"
              placeholder="Спросите о проекте…"
              rows={2}
              maxLength={12000}
              value={draft}
              disabled={configured !== true || loading}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button
                type="button"
                className="assistant-send"
                aria-label="Остановить ожидание ответа"
                onClick={stop}
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                className="assistant-send"
                aria-label="Отправить сообщение"
                disabled={
                  !draft.trim() || configured !== true || interactionBusy
                }
              >
                <ArrowUp size={18} />
              </button>
            )}
          </form>
          <p className="assistant-disclosure">
            DeepSeek получает сообщения и контекст выбранного проекта
          </p>
        </section>
      )}
    </div>
  );
}
