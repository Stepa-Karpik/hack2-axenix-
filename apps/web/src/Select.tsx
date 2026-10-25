import {
  Children,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "./select.css";

type Option = { value: string; label: ReactNode; disabled: boolean };
function optionsOf(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap((child): Option[] => {
    if (
      !isValidElement<{
        value?: string;
        children?: ReactNode;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === "option")
      return [
        {
          value: String(child.props.value ?? child.props.children ?? ""),
          label: child.props.children,
          disabled: !!child.props.disabled,
        },
      ];
    return optionsOf(child.props.children);
  });
}
function text(value: ReactNode): string {
  return Children.toArray(value)
    .map((v) =>
      isValidElement<{ children?: ReactNode }>(v)
        ? text(v.props.children)
        : String(v ?? ""),
    )
    .join("");
}
/** Styled listbox; the hidden select preserves ordinary form/change semantics. */
export default function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { children, className = "", id, disabled, style, ...rest } = props;
  const uid = useId(),
    listId = uid + "-options";
  const native = useRef<HTMLSelectElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [index, setIndex] = useState(0);
  const [implicitLabel, setImplicitLabel] = useState<string>();
  const [box, setBox] = useState({ top: 0, left: 0, width: 0, maxHeight: 300 });
  const options = optionsOf(children),
    value = String(
      props.value ?? props.defaultValue ?? options[0]?.value ?? "",
    );
  const selected = options.find((o) => o.value === value);
  const typed = useRef({ value: "", time: 0 });
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(i: number) {
    const option = options[i];
    if (!option || option.disabled || !native.current) return;
    native.current.value = option.value;
    native.current.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }
  function move(delta: number) {
    setIndex((old) => {
      for (let n = 1; n <= options.length; n++) {
        const next = (old + delta * n + options.length * 2) % options.length;
        if (!options[next].disabled) return next;
      }
      return old;
    });
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const below = innerHeight - r.bottom - 12,
        above = r.top - 12;
      const height = Math.min(
        320,
        Math.max(below, above),
        options.length * 38 + 12,
      );
      const width = Math.min(Math.max(r.width, 180), innerWidth - 16);
      setBox({
        left: Math.min(
          Math.max(8, r.left),
          Math.max(8, innerWidth - width - 8),
        ),
        top: below >= height ? r.bottom + 6 : Math.max(8, r.top - height - 6),
        width,
        maxHeight: height,
      });
    };
    place();
    list.current?.focus();
    const outside = (e: PointerEvent) => {
      if (
        !list.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("blur", blur);
    };
  }, [open, options.length]);
  useLayoutEffect(() => {
    list.current
      ?.querySelector(`[data-option-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, open]);
  useLayoutEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    const parent = trigger.current?.closest("label");
    if (!parent) return;
    const copy = parent.cloneNode(true) as HTMLElement;
    copy
      .querySelectorAll("select,button,input,textarea,svg")
      .forEach((el) => el.remove());
    setImplicitLabel(copy.textContent?.trim() || undefined);
  }, [children]);
  return (
    <>
      <select
        {...rest}
        id={undefined}
        ref={native}
        disabled={disabled}
        required={false}
        aria-hidden="true"
        aria-label={undefined}
        tabIndex={-1}
        hidden
        data-select-native="true"
      >
        {children}
      </select>
      <button
        id={id}
        ref={trigger}
        type="button"
        role="combobox"
        data-value={value}
        className={"custom-select " + className}
        style={style}
        disabled={disabled}
        aria-label={props["aria-label"] ?? implicitLabel}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        aria-required={props.required}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setIndex(
            Math.max(
              0,
              options.findIndex((o) => o.value === value),
            ),
          );
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            setIndex(
              Math.max(
                0,
                options.findIndex((o) => o.value === value),
              ),
            );
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? "Выберите…"}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            id={listId}
            ref={list}
            tabIndex={-1}
            role="listbox"
            aria-label={props["aria-label"] ?? "Варианты"}
            aria-activedescendant={uid + "-" + index}
            className="custom-select-popup"
            style={box}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === "Tab") {
                setOpen(false);
                trigger.current?.focus();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                const enabled = options
                  .map((o, i) => (!o.disabled ? i : -1))
                  .filter((i) => i >= 0);
                setIndex((e.key === "Home" ? enabled[0] : enabled.at(-1)) ?? 0);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                choose(index);
              } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                const now = Date.now();
                typed.current = {
                  time: now,
                  value:
                    (now - typed.current.time < 700
                      ? typed.current.value
                      : "") + e.key.toLocaleLowerCase(),
                };
                const i = options.findIndex(
                  (o) =>
                    !o.disabled &&
                    text(o.label)
                      .toLocaleLowerCase()
                      .startsWith(typed.current.value),
                );
                if (i >= 0) setIndex(i);
              }
            }}
          >
            {options.map((o, i) => (
              <div
                key={i}
                id={uid + "-" + i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled}
                data-option-index={i}
                className={
                  (i === index ? "focused " : "") +
                  (o.disabled ? "disabled" : "")
                }
                onPointerMove={() => !o.disabled && setIndex(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span>{o.label}</span>
                {o.value === value && <Check size={14} />}
              </div>
            ))}
          </div>,
          trigger.current?.closest('dialog,[role="dialog"]') ?? document.body,
        )}
    </>
  );
}
