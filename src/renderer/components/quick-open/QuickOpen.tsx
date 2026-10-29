import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { stepList } from "../../lib/list-nav";
import {
  comboboxFieldAria,
  listboxAnnouncement,
  listboxAria,
  optionAria,
  type ListboxAriaState,
  type ListboxNoun,
} from "../../lib/listbox-aria";
import { claimFocus } from "../../lib/focus-ownership";
import { keyIs } from "../../lib/key-match";
import type { QuickOpenItem, QuickOpenSource } from "../../lib/quick-open";
import { Kbd } from "../ui/Kbd";
import "./quick-open.css";

/** Singular and plural of what a source offers: its kind's own word. */
const nounOf = (source: QuickOpenSource): ListboxNoun => ({
  one: source.kind,
  other: `${source.kind}s`,
});

/**
 * Quick open (0.11, F4): the palette inside a node's modal, over the list that
 * modal already holds. The operator types, the source answers with its ranked
 * rows (files in main, the rest with `lib/fuzzy-match`), and Enter opens the
 * row the highlight sits on.
 *
 * It sits in the middle of the modal, a card over that modal's own panel, so
 * the operator's eye does not travel to a corner: the frame is one fixed
 * height, centred across the panel, near its top, with a light dim under it.
 * It is a combobox, the same shape as the command bar: the field keeps the
 * keyboard, the highlight is `aria-activedescendant`, and the movement is
 * `lib/list-nav`'s clamped stepping. A bare key never opens a row behind a
 * field, so J and K type where the caret is and the arrows move the highlight.
 *
 * Escape, a press on the dim and Tab close it, and only those: the modal
 * behind it owns its own keys, and an async focus claim from that modal must
 * not shut a palette the operator just opened.
 */
export function QuickOpen({
  source,
  onOpen,
  onClose,
}: {
  readonly source: QuickOpenSource;
  readonly onOpen: (item: QuickOpenItem) => void;
  readonly onClose: () => void;
}) {
  const baseId = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<{ readonly query: string; readonly rows: readonly QuickOpenItem[] }>({
    query: "",
    rows: [],
  });
  const [pending, setPending] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  // A palette is nothing without its field: the keyboard goes in on open.
  useEffect(() => {
    claimFocus(fieldRef.current, "open");
  }, []);

  // A source rebuilt on a render (a list that changed) is not a new question:
  // the palette re-asks per keystroke, never per paint.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  });

  useEffect(() => {
    let live = true;
    const settle = (rows: readonly QuickOpenItem[]): void => {
      if (!live) return;
      setAnswer({ query, rows });
      setPending(false);
    };
    try {
      const searched = sourceRef.current.search(query);
      if (searched instanceof Promise) {
        setPending(true);
        void searched.then(settle, () => settle([]));
      } else {
        settle(searched);
      }
    } catch {
      settle([]);
    }
    return () => {
      live = false;
    };
  }, [query]);

  const rows = answer.rows;
  // The top match is where Enter lands, whatever the query just became.
  useEffect(() => {
    setActive(answer.rows[0]?.id ?? null);
  }, [answer]);

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const aria: ListboxAriaState = {
    baseId,
    presentation: "inline",
    autocomplete: "list",
    open: true,
    keys: ids,
    activeKey: active ?? undefined,
    selection: { kind: "highlight" },
  };
  // One sentence for eyes and ears: with rows the footer carries the count, with
  // none the line under the list carries the words and is the live region, so a
  // failed search is never said twice.
  const nothing = rows.length === 0 && !pending;
  const talk = listboxAnnouncement({ open: true, count: rows.length, noun: nounOf(source) });
  const quietLine = nothing ? (query === "" ? source.hint : source.empty) : null;

  const pick = (id: string | null): void => {
    const row = rows.find((candidate) => candidate.id === id);
    if (row !== undefined) onOpen(row);
  };

  /** The highlight moved: a row far down the list comes into view without a scroll of its own. */
  useEffect(() => {
    if (active === null) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-quick-row]") ?? [])].find(
      (element) => element.dataset.quickRow === active,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // The palette's Escape, never the modal's: the modal stays open.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Tab is the operator leaving: no combobox stays armed behind them.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (keyIs(event.nativeEvent, "inQuickOpen.move")) {
      event.preventDefault();
      setActive(stepList(ids, active, event.key === "ArrowUp" ? "previous" : "next"));
      return;
    }
    const first = active ?? ids[0];
    // Enter is the field's key, not the palette's. On the clear button it is
    // that button's own activation: a row must not open behind it, and the
    // modal behind must not act on it either.
    if (event.target !== fieldRef.current) {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      return;
    }
    if (first !== undefined && keyIs(event.nativeEvent, "inQuickOpen.open")) {
      // A row that opens is the palette's Enter, never the modal's behind it.
      event.preventDefault();
      event.stopPropagation();
      pick(first);
    }
  };

  return (
    <div className="quick-open" data-testid="quick-open" onKeyDown={onKeyDown}>
      <button
        type="button"
        className="quick-open__scrim"
        // The dim is a pointer target only: Escape and Tab are the named ways out.
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className="quick-open__card" role="dialog" aria-label={source.find}>
        <div className="quick-open__field">
          <Search size={14} aria-hidden />
          <input
            ref={fieldRef}
            {...comboboxFieldAria(aria)}
            aria-label={source.find}
            data-testid="quick-open-input"
            value={query}
            placeholder={source.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query === "" ? null : (
            <button
              type="button"
              className="quick-open__clear"
              aria-label="Clear search"
              // A press must not pull the caret out of the field, and clearing
              // is more typing, not a pick: the press only holds focus here.
              // The click is the clear, and it is the one activation every way
              // in produces: a pointer press, Enter or Space on the button, and
              // a screen reader's invoke.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                setQuery("");
                claimFocus(fieldRef.current, "gesture", { event });
              }}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
        <ul
          {...listboxAria(aria)}
          ref={listRef}
          aria-label={source.find}
          aria-busy={pending}
          className="quick-open__list"
        >
          {rows.map((row) => {
            const option = optionAria(aria, row.id);
            const shown = row.id === active;
            return (
              <li
                key={row.id}
                {...option}
                data-quick-row={row.id}
                className="quick-open__row"
                data-active={shown ? "true" : undefined}
                // Move the highlight without taking the caret out of the field.
                onPointerMove={() => setActive(row.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(row.id)}
              >
                <span className="quick-open__row-main">
                  <span className="quick-open__row-title">{row.title}</span>
                  {row.detail === undefined ? null : <span className="quick-open__row-detail">{row.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {quietLine === null ? null : (
          <p className="quick-open__empty" role="status" aria-live="polite" aria-atomic="true">
            {quietLine}
          </p>
        )}
        <div className="quick-open__foot">
          {nothing ? null : (
            <span className="quick-open__count" role="status" aria-live="polite" aria-atomic="true">
              {talk}
            </span>
          )}
          <span className="quick-open__hints">
            <Kbd>↑↓</Kbd>
            <span className="quick-open__hint">move</span>
            <Kbd>↵</Kbd>
            <span className="quick-open__hint">open</span>
            <Kbd>esc</Kbd>
            <span className="quick-open__hint">close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
