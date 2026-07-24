import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type DropdownOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

type MenuBox = {
  readonly top: number;
  readonly left: number;
  readonly minWidth: number;
  readonly maxHeight: number;
  readonly placement: "below" | "above";
};

/**
 * Design-system dropdown — custom listbox, never a native <select>.
 * Trigger stays in flow; the menu portals to document.body so overflow
 * parents (segmented chrome, toolbars) cannot clip it. Keyboard: arrows,
 * Home/End, Enter/Space, Escape, type-ahead.
 */
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-busy": ariaBusy,
  title,
  placeholder = "select…",
  emptyLabel = "no options",
  className,
  triggerClassName,
  menuClassName,
  uppercase = false,
  align = "start",
}: {
  readonly value: string;
  readonly options: ReadonlyArray<DropdownOption>;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly "aria-label": string;
  readonly "aria-busy"?: boolean;
  readonly title?: string;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly menuClassName?: string;
  /** Uppercase labels (canvas names, status enums). */
  readonly uppercase?: boolean;
  readonly align?: "start" | "end";
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<MenuBox | null>(null);
  const [highlight, setHighlight] = useState(0);
  const typeaheadRef = useRef({ buffer: "", at: 0 });

  const selected = options.find((o) => o.value === value);
  const enabledIndexes = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const close = useCallback(() => {
    setOpen(false);
    setBox(null);
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    const activeIdx = options.findIndex((o) => o.value === value && !o.disabled);
    setHighlight(activeIdx >= 0 ? activeIdx : (enabledIndexes[0] ?? 0));
    setOpen(true);
  }, [disabled, enabledIndexes, options, value]);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const preferredMax = 280;
    const spaceBelow = window.innerHeight - rect.bottom - gap - 12;
    const spaceAbove = rect.top - gap - 12;
    const placeBelow = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(96, Math.min(preferredMax, placeBelow ? spaceBelow : spaceAbove));
    const minWidth = Math.max(rect.width, 148);
    let left = align === "end" ? rect.right - minWidth : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - minWidth - 8));
    setBox({
      top: placeBelow ? rect.bottom + gap : rect.top - gap,
      left,
      minWidth,
      maxHeight,
      placement: placeBelow ? "below" : "above",
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onReposition = () => measure();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, measure, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
    triggerRef.current?.focus();
  };

  const moveHighlight = (delta: number) => {
    if (enabledIndexes.length === 0) return;
    const currentPos = enabledIndexes.indexOf(highlight);
    const base = currentPos >= 0 ? currentPos : 0;
    const nextPos = (base + delta + enabledIndexes.length) % enabledIndexes.length;
    setHighlight(enabledIndexes[nextPos]!);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else if (event.key === "Enter" || event.key === " ") commit(highlight);
      else if (event.key === "ArrowDown") moveHighlight(1);
      else moveHighlight(-1);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (enabledIndexes[0] !== undefined) setHighlight(enabledIndexes[0]);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const last = enabledIndexes[enabledIndexes.length - 1];
      if (last !== undefined) setHighlight(last);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(highlight);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    // Type-ahead
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      if (now - typeaheadRef.current.at > 700) typeaheadRef.current.buffer = "";
      typeaheadRef.current.buffer += event.key.toLowerCase();
      typeaheadRef.current.at = now;
      const buf = typeaheadRef.current.buffer;
      const start = options.findIndex(
        (o, i) => !o.disabled && i >= highlight && o.label.toLowerCase().startsWith(buf),
      );
      const wrap = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(buf));
      const hit = start >= 0 ? start : wrap;
      if (hit >= 0) setHighlight(hit);
    }
  };

  const labelText = selected?.label ?? (options.length === 0 ? emptyLabel : placeholder);
  const caseClass = uppercase ? "uppercase tracking-[0.06em]" : "";

  const menuStyle: CSSProperties | undefined = box
    ? {
        position: "fixed",
        left: box.left,
        minWidth: box.minWidth,
        maxHeight: box.maxHeight,
        zIndex: 200,
        ...(box.placement === "below"
          ? { top: box.top }
          : { top: box.top, transform: "translateY(-100%)" }),
      }
    : undefined;

  const menu =
    open && box
      ? createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-activedescendant={options[highlight] ? `${listId}-opt-${highlight}` : undefined}
            className={[
              "overflow-y-auto rounded-[8px] border border-stroke bg-[rgba(19,17,16,0.98)]",
              "py-1 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-xl outline-none",
              menuClassName ?? "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={menuStyle}
            onKeyDown={onMenuKeyDown}
          >
            {options.length === 0 ? (
              <div className={`px-3 py-2 text-[11px] text-faint ${caseClass}`}>{emptyLabel}</div>
            ) : (
              options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === highlight;
                return (
                  <div
                    key={option.value || `empty-${index}`}
                    id={`${listId}-opt-${index}`}
                    role="option"
                    data-index={index}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={[
                      "flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[11px] text-ink",
                      caseClass,
                      option.disabled ? "cursor-not-allowed opacity-40" : "",
                      isActive && !option.disabled ? "bg-amber/[0.12] text-amber-hi" : "",
                      isSelected && !isActive ? "text-amber" : "",
                      !isActive && !isSelected && !option.disabled ? "hover:bg-white/[0.05]" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onMouseEnter={() => {
                      if (!option.disabled) setHighlight(index);
                    }}
                    onMouseDown={(event) => {
                      // Prevent blur-before-click on the trigger.
                      event.preventDefault();
                    }}
                    onClick={() => commit(index)}
                  >
                    <span className="grid size-3.5 shrink-0 place-items-center">
                      {isSelected ? <Check size={12} strokeWidth={2.4} className="text-amber" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  </div>
                );
              })
            )}
          </div>,
          document.body,
        )
      : null;

  // Focus menu when opened so arrow keys work immediately.
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open, box]);

  return (
    <div ref={rootRef} className={["relative inline-flex min-w-0", className ?? ""].filter(Boolean).join(" ")}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-busy={ariaBusy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={title}
        className={[
          "inline-flex h-full min-w-0 items-center gap-1.5 text-left text-ink outline-none",
          "disabled:cursor-wait disabled:opacity-60",
          triggerClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => {
          if (open) close();
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`min-w-0 flex-1 truncate text-[11px] font-medium ${caseClass}`}>{labelText}</span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          className={`shrink-0 text-dim transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {menu}
    </div>
  );
}
