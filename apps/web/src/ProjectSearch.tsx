import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Search } from "lucide-react";
import { searchProject } from "./searchIndex";
import type { SearchHit } from "./searchIndex";
import type { Graph } from "./types";
export default function ProjectSearch({
  files,
  graph,
  inputRef,
  onSelect,
}: {
  files: Record<string, string>;
  graph: Graph | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onSelect: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    results = searchProject(files, graph, query);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  function choose(hit: SearchHit) {
    onSelect(hit);
    setOpen(false);
  }
  return (
    <div className="project-command-search" ref={root} data-tour="search">
      <label className="global-search">
        <Search size={17} />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Поиск по проекту"
          aria-expanded={open && !!query.trim()}
          aria-controls={
            open && query.trim() ? "project-search-results" : undefined
          }
          aria-activedescendant={
            open && results[index] ? "project-hit-" + index : undefined
          }
          placeholder="Файл, метод, код или блок"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setIndex((i) =>
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    i + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === "Enter" && results[index]) {
              e.preventDefault();
              choose(results[index]);
            }
          }}
        />
        <kbd>Ctrl K</kbd>
      </label>
      {open && query.trim() && (
        <div
          className="project-search-results"
          id="project-search-results"
          role="listbox"
          aria-label="Результаты поиска"
        >
          {results.length ? (
            results.map((hit, i) => (
              <button
                id={"project-hit-" + i}
                key={hit.id}
                role="option"
                aria-selected={index === i}
                className={index === i ? "active" : ""}
                onPointerMove={() => setIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(hit)}
              >
                <strong>{hit.title}</strong>
                <small>{hit.detail}</small>
              </button>
            ))
          ) : (
            <p>Ничего не найдено</p>
          )}
        </div>
      )}
    </div>
  );
}
