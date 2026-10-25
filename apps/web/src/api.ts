export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
let csrf: string | undefined;
let csrfEpoch = 0;
export function setSessionCsrf(token: string) {
  csrfEpoch++;
  csrf = token;
  sessionPromise = undefined;
}
let sessionPromise: Promise<void> | undefined;
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    head?: string | null;
    signal?: AbortSignal;
    key?: string;
  } = {},
  csrfRetried = false,
): Promise<T> {
  const method = options.method ?? "GET";
  if (method !== "GET" && !csrf) {
    if (!sessionPromise) {
      const epoch = csrfEpoch;
      const pending = api<{ csrfToken: string }>("/session")
        .then((session) => {
          if (epoch === csrfEpoch) csrf = session.csrfToken;
        })
        .finally(() => {
          if (sessionPromise === pending) sessionPromise = undefined;
        });
      sessionPromise = pending;
    }
    await sessionPromise;
  }
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["X-CSRF-Token"] = csrf!;
    headers["Idempotency-Key"] = options.key ?? crypto.randomUUID();
  }
  if (options.head !== undefined) headers["If-Match"] = options.head ?? "empty";
  const multipart = options.body instanceof FormData;
  if (options.body !== undefined && !multipart)
    headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch("/api/v1" + path, {
      method,
      headers,
      body:
        options.body === undefined
          ? undefined
          : multipart
            ? (options.body as FormData)
            : JSON.stringify(options.body),
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Сервер недоступен. Проверьте подключение и повторите действие.",
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(
      response.status,
      "SERVER_UNAVAILABLE",
      "Сервер недоступен. Повторите после восстановления подключения.",
    );
  const json = await response.json();
  if (
    !response.ok &&
    json.error?.code === "CSRF_INVALID" &&
    method !== "GET" &&
    !csrfRetried
  ) {
    if (csrf === headers["X-CSRF-Token"]) {
      csrfEpoch++;
      csrf = undefined;
      sessionPromise = undefined;
    }
    return api<T>(path, { ...options, key: headers["Idempotency-Key"] }, true);
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      json.error?.code ?? "NETWORK_ERROR",
      json.error?.message ?? `HTTP ${response.status}`,
    );
  if (
    (path === "/auth/login" || path === "/auth/logout") &&
    typeof json.data?.csrfToken === "string"
  )
    setSessionCsrf(json.data.csrfToken);
  return json.data as T;
}
export const projectPath = (id: string) =>
  "/projects/" + encodeURIComponent(id);
export async function pollJob<T extends { status: string }>(
  read: () => Promise<T>,
  signal: AbortSignal,
  onProgress?: (job: T) => void,
): Promise<T> {
  for (let i = 0; i < 12000; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const job = await read();
    onProgress?.(job);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    const comparison = "type" in job && job.type === "compare";
    if (i >= 1199 && !comparison) break;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        comparison
          ? 500
          : "type" in job && job.type === "run"
            ? 300
            : "type" in job && job.type === "analyze"
              ? i < 20
                ? 100
                : 500
              : Math.min(500 * 2 ** Math.min(i, 3), 5000),
      );
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("Ожидание приостановлено. Обновите статус задания.");
}
