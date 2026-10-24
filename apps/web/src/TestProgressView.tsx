import { useEffect, useRef, useState } from "react";
import { Crosshair } from "lucide-react";
import type { Job } from "./types";
import {
  progressTitle,
  testDuration,
  testStatusLabels,
  testReason,
  visibleTestStatus,
} from "./testProgress";

export default function TestProgressView({ job }: { job: Job }) {
  const progress = job.progress;
  const total = progress?.total ?? 0;
  const completed = Math.min(total, Math.max(0, progress?.completed ?? 0));
  const listRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const activeId = progress?.cases.find(
    (test) => test.status === "running",
  )?.caseId;
  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId || !following) return;
    const reveal = () => {
      if (!list.clientHeight) return;
      const active = Array.from(list.children).find(
        (row) => row.getAttribute("data-test-case") === activeId,
      );
      if (!active) return;
      const parent = list.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.bottom > parent.bottom)
        list.scrollTop += row.bottom - parent.bottom;
      else if (row.top < parent.top) list.scrollTop -= parent.top - row.top;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, following]);
  const interrupted =
    !!progress &&
    !progress.finished &&
    ["failed", "cancelled", "succeeded"].includes(job.status);
  return (
    <section className="tests-progress" aria-label="Прогресс тестов">
      <div
        className="tests-progress-heading"
        title={
          progress
            ? `${progress.binding.baseRevisionId} → ${progress.binding.candidateRevisionId}`
            : undefined
        }
      >
        <strong role="status">
          {progressTitle(
            progress?.phase,
            job.status,
            !!job.cancelRequestedAt && job.status === "running",
          )}
        </strong>
        {progress && (
          <span aria-label="Время проверки">
            {testDuration(interrupted ? null : progress.elapsedMs)}
          </span>
        )}
        {activeId && !following && (
          <button
            type="button"
            className="icon-button progress-follow"
            aria-label="Показать текущий тест"
            title="Показать текущий тест"
            onClick={() => setFollowing(true)}
          >
            <Crosshair size={14} />
          </button>
        )}
      </div>
      {progress && (
        <>
          <div className="tests-progress-counts">
            <span>
              Выполнено {completed} из {total}
            </span>
            <span>Совпало {progress.matched}</span>
          </div>
          <progress
            aria-label="Выполнено тестов"
            value={completed}
            max={Math.max(1, total)}
          />
          <ol
            className="tests-progress-list"
            ref={listRef}
            tabIndex={0}
            aria-label="Тестовые случаи"
            onWheel={() => setFollowing(false)}
            onTouchMove={() => setFollowing(false)}
            onKeyDown={(event) => {
              if (
                [
                  "ArrowUp",
                  "ArrowDown",
                  "PageUp",
                  "PageDown",
                  "Home",
                  "End",
                  " ",
                ].includes(event.key)
              )
                setFollowing(false);
            }}
          >
            {progress.cases.map((test) => {
              const status = visibleTestStatus(test.status, job.status);
              return (
                <li
                  key={test.caseId}
                  data-test-case={test.caseId}
                  data-test-status={status}
                >
                  <span
                    className={"progress-test-icon status-" + status}
                    aria-hidden="true"
                  >
                    {status === "matched"
                      ? "✓"
                      : status === "mismatch"
                        ? "×"
                        : status === "running"
                          ? "◌"
                          : "·"}
                  </span>
                  <div className="progress-test-info">
                    <div className="progress-test-label">
                      <strong title={test.name}>
                        {test.name || test.caseId}
                      </strong>
                      <span>{testStatusLabels[status] ?? status}</span>
                    </div>
                    {["running", "cancelled", "inconclusive"].includes(
                      status,
                    ) && (
                      <small>
                        База {test.baseObserved}/{progress.plannedRepeatCount} ·
                        Кандидат {test.candidateObserved}/
                        {progress.plannedRepeatCount}
                      </small>
                    )}
                    {status === "inconclusive" && test.reasons.length > 0 && (
                      <small className="progress-test-reason">
                        {test.reasons.map(testReason).join(" · ")}
                      </small>
                    )}
                  </div>
                  <span className="progress-test-time">
                    {testDuration(
                      interrupted && test.status === "running"
                        ? null
                        : test.elapsedMs,
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {job.error && (
        <div className="notice error" role="alert">
          {job.error.code === "LEASE_EXPIRED"
            ? "Сессия проверки прервана. Результаты выполненных шагов сохранены."
            : (job.error.message ?? "Проверка прервана")}
        </div>
      )}
    </section>
  );
}
