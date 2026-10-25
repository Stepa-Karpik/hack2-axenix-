import { useRef, useState, useEffect } from "react";
import { api, projectPath } from "./api";
import type { LiveRun } from "./types";

export default function LiveConsole({
  projectId,
  jobId,
  live,
  status = "running",
  readOnly = false,
}: {
  projectId: string;
  jobId: string;
  live?: LiveRun | null;
  status?: string;
  readOnly?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [echo, setEcho] = useState<string[]>([]);
  const pending = useRef<{ key: string; text: string; eof: boolean } | null>(
    null,
  );
  const output = useRef<HTMLPreElement>(null);
  const bottom = useRef(true);
  const currentJob = useRef(jobId);
  currentJob.current = jobId;
  const sending = useRef(false);
  useEffect(() => {
    if (bottom.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [live?.stdoutUtf8, live?.stderrUtf8]);
  useEffect(() => {
    setText("");
    setEcho([]);
    pending.current = null;
    setError("");
    sending.current = false;
    setBusy(false);
  }, [jobId]);
  async function send(eof = false) {
    if (readOnly || sending.current || !live?.inputOpen) return;
    const data = eof ? "" : text + "\n";
    const frame =
      pending.current?.text === data && pending.current.eof === eof
        ? pending.current
        : { key: crypto.randomUUID(), text: data, eof };
    pending.current = frame;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await api(projectPath(projectId) + `/runs/${jobId}/input`, {
        method: "POST",
        key: frame.key,
        body: { text: frame.text, eof: frame.eof },
      });
      if (currentJob.current !== jobId) return;
      setEcho((old) => [...old, eof ? "⏎ EOF" : "> " + text]);
      setText("");
      pending.current = null;
    } catch (e) {
      if (currentJob.current === jobId)
        setError(e instanceof Error ? e.message : "Не удалось отправить ввод");
    } finally {
      if (currentJob.current === jobId) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="live-console" aria-label="Интерактивная консоль">
      <div className="live-console-status">
        <span>
          {!live
            ? status === "queued"
              ? "В очереди запуска…"
              : "Подготовка изолированной среды…"
            : live.phase === "runtime"
              ? "Программа работает"
              : "Компиляция…"}
        </span>
        <span>
          {live
            ? Math.round(live.elapsedMs / 1000) +
              " с · лимит 120 с · вывод ≤ 1 МиБ"
            : "Ожидаем состояние runner"}
        </span>
      </div>
      <pre
        ref={output}
        className="live-console-output"
        onScroll={() => {
          const el = output.current!;
          bottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 35;
        }}
        aria-live="polite"
      >
        {live?.stdoutUtf8}
        <span className="console-stderr">{live?.stderrUtf8}</span>
      </pre>
      {echo.length > 0 && (
        <details className="console-input-history">
          <summary>Отправленный ввод · {echo.length}</summary>
          <pre>{echo.join("\n")}</pre>
        </details>
      )}
      <form
        className="console-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <span aria-hidden="true">❯</span>
        <input
          aria-label="Ответ программе"
          placeholder="Ответ программе…"
          value={text}
          disabled={readOnly || !live?.inputOpen || busy}
          onChange={(e) => setText(e.target.value)}
        />
        <button disabled={readOnly || !live?.inputOpen || busy} type="submit">
          Отправить
        </button>
        <button
          disabled={readOnly || !live?.inputOpen || busy}
          type="button"
          title="Завершить стандартный ввод"
          onClick={() => void send(true)}
        >
          Завершить ввод
        </button>
      </form>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
    </section>
  );
}
