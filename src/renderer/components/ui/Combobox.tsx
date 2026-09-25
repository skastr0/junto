import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { comboboxKeyIntent, ghostSuffix } from "../../lib/combobox";
import { Input } from "./Field";
import { claimFocus } from "../../lib/focus-ownership";

/**
 * House typeahead: a text field over an always-visible listbox.
 *
 * The value is only what the user typed. A completion draws as faint ghost
 * text past the caret (Tab or ArrowRight at the end takes it); arrows move a
 * highlight through the list via aria-activedescendant without writing into
 * the field; Enter commits the highlighted option, or the typed value when
 * none is; Escape clears the highlight and ghost before it reaches the
 * surface. Keyboard rules live in `lib/combobox.ts`.
 */
export function Combobox<T>({
  value,
  onValueChange,
  completion,
  options,
  optionKey,
  renderOption,
  activeKey,
  onActiveKeyChange,
  selectedKey,
  onCommit,
  onOptionClick,
  onOptionDoubleClick,
  "aria-label": ariaLabel,
  listLabel,
  placeholder,
  trailing,
  status,
  empty,
  listClassName,
}: {
  readonly value: string;
  /** Typing, and accepting the ghost. Never called by highlight moves. */
  readonly onValueChange: (value: string) => void;
  /** Full value the ghost completes to; drawn only while it extends `value`. */
  readonly completion?: string;
  readonly options: readonly T[];
  readonly optionKey: (option: T) => string;
  readonly renderOption: (
    option: T,
    state: { readonly active: boolean; readonly selected: boolean },
  ) => ReactNode;
  readonly activeKey: string | undefined;
  readonly onActiveKeyChange: (key: string | undefined) => void;
  /** The option the current value already names (aria-selected). */
  readonly selectedKey?: string;
  /**
   * Enter. `option` is the highlighted one, if any; `value` is the typed value
   * with any visible ghost taken, so Enter never discards a shown completion.
   */
  readonly onCommit: (option: T | undefined, value: string) => void;
  readonly onOptionClick?: (option: T) => void;
  readonly onOptionDoubleClick?: (option: T) => void;
  readonly "aria-label": string;
  readonly listLabel: string;
  readonly placeholder?: string;
  /** Controls beside the field (icon buttons). */
  readonly trailing?: ReactNode;
  /** Replaces the list inside its frame (loading, error). */
  readonly status?: ReactNode;
  /** Shown under the list while it has no options. */
  readonly empty?: ReactNode;
  readonly listClassName?: string;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const ghostRef = useRef<HTMLSpanElement>(null);
  const [focused, setFocused] = useState(false);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [dismissedFor, setDismissedFor] = useState<string>();

  const activeIndex = activeKey === undefined
    ? -1
    : options.findIndex((option) => optionKey(option) === activeKey);
  const suffix = focused
    ? ghostSuffix({ value, completion, caretAtEnd, dismissedFor })
    : "";

  /** Caret position and horizontal scroll decide where the ghost sits. */
  const syncCaret = () => {
    const input = inputRef.current;
    if (!input) return;
    const end = input.value.length;
    setCaretAtEnd(input.selectionStart === end && input.selectionEnd === end);
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translateX(${-input.scrollLeft}px)`;
    }
  };

  useLayoutEffect(syncCaret, [value, suffix]);

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from the stable baseId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const listVisible = status === undefined || status === null;

  return (
    <div className="grid min-h-0 gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            ref={inputRef}
            role="combobox"
            aria-label={ariaLabel}
            aria-autocomplete="both"
            aria-expanded={listVisible && options.length > 0}
            aria-controls={listVisible ? listId : undefined}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            value={value}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            onFocus={() => {
              setFocused(true);
              syncCaret();
            }}
            onBlur={() => setFocused(false)}
            onSelect={syncCaret}
            onScroll={syncCaret}
            onChange={(event) => {
              if (activeKey !== undefined) onActiveKeyChange(undefined);
              onValueChange(event.target.value);
            }}
            onKeyDown={(event) => {
              const intent = comboboxKeyIntent(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                {
                  optionCount: listVisible ? options.length : 0,
                  activeIndex,
                  ghost: suffix !== "",
                  caretAtEnd,
                },
              );
              switch (intent.type) {
                case "none":
                  return;
                case "highlight": {
                  event.preventDefault();
                  const option = options[intent.index];
                  if (option !== undefined) onActiveKeyChange(optionKey(option));
                  return;
                }
                case "accept":
                  event.preventDefault();
                  if (activeKey !== undefined) onActiveKeyChange(undefined);
                  if (completion !== undefined) onValueChange(completion);
                  return;
                case "commit": {
                  event.preventDefault();
                  const option =
                    intent.index === undefined ? undefined : options[intent.index];
                  // A highlighted row is the field's own business; a bare Enter
                  // still reaches the surface (wizards submit on it).
                  if (option !== undefined) event.stopPropagation();
                  onCommit(option, suffix ? `${value}${suffix}` : value);
                  return;
                }
                case "dismiss":
                  event.preventDefault();
                  event.stopPropagation();
                  onActiveKeyChange(undefined);
                  setDismissedFor(value);
                  return;
              }
            }}
          />
          {suffix ? (
            <div
              aria-hidden
              className={[
                "pointer-events-none absolute inset-0 flex items-center overflow-hidden",
                "rounded-[5px] border border-transparent px-2 text-[12px] leading-normal",
                "whitespace-pre",
              ].join(" ")}
            >
              <span ref={ghostRef} className="inline-block">
                <span className="invisible">{value}</span>
                <span className="text-faint">{suffix}</span>
              </span>
            </div>
          ) : null}
        </div>
        {trailing}
      </div>

      <div
        className={[
          "overflow-hidden rounded-[5px] border border-stroke bg-inset",
          listClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {listVisible ? (
          <>
            <ul
              id={listId}
              role="listbox"
              aria-label={listLabel}
              className="grid max-h-[220px] gap-px overflow-y-auto p-1 font-mono text-[11px]"
            >
              {options.map((option, index) => {
                const key = optionKey(option);
                const active = index === activeIndex;
                const selected = key === selectedKey;
                return (
                  <li
                    key={key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    className={[
                      "cursor-pointer rounded-[4px]",
                      active || selected ? "bg-raise text-ink" : "text-ink-2 hover:bg-raise/60",
                      active ? "shadow-[inset_2px_0_0_var(--color-cyan)]" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    // Keep the caret in the field: the list is a way to keep typing.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      claimFocus(inputRef.current, "gesture", { event });
                      onOptionClick?.(option);
                    }}
                    onDoubleClick={() => onOptionDoubleClick?.(option)}
                  >
                    {renderOption(option, { active, selected })}
                  </li>
                );
              })}
            </ul>
            {options.length === 0 ? empty : null}
          </>
        ) : (
          status
        )}
      </div>
    </div>
  );
}
