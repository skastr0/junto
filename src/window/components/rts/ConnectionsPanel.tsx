import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { ArrowLeft, ArrowRight, Search, X } from "lucide-react";
import { asNodeId } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { deleteEdges } from "../../lib/edge-mutations";
import { claimFocus } from "../../lib/focus-ownership";
import { listIntentOf, useListNav } from "../../lib/list-nav";
import { openerBorrowedKeyboard, returnKeyboardFrom } from "../../lib/modal-stack";
import { isMac } from "../../lib/platform";
import {
  groupConnections,
  matchConnections,
  seatConnections,
  type ConnectionWay,
  type SeatConnection,
} from "../../lib/seat-connections";
import { state$ } from "../../lib/state";
import { accentColor } from "../../lib/theme";
import { useCanvas } from "../../lib/use-model";
import { AgentPortrait } from "../AgentPortrait";
import { KindMark } from "../NodeKindMark";
import { Button } from "../ui/Button";
import { Eyebrow } from "../ui/Eyebrow";
import { IconButton } from "../ui/IconButton";
import { ConnectEditor } from "./ConnectEditor";
import { useOverlayHold } from "../../lib/overlay-open";
import "./connections-panel.css";

const WAY_ICON: Readonly<Record<ConnectionWay, typeof ArrowRight>> = {
  out: ArrowRight,
  in: ArrowLeft,
};

/** A wire id in a selector: ids are plain, and jsdom has no CSS.escape. */
const escapeId = (id: string): string =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;

/** Focus is lost to the page, as when the focused control was removed with its row. */
const focusLost = (): boolean => {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
};

/** "Remove 3", or the one row's own words. */
const removeLabel = (count: number): string => `Remove ${count}`;

/** How a removal is taken back, said as this platform writes it. */
const undoWords = (): string => `Undo with ${isMac() ? "Command Z" : "Control Z"}.`;

/** What a removal is said as: "Removed: <sentence>", and how to undo it. */
const removedWords = (sentences: ReadonlyArray<string>): string =>
  sentences.length === 1
    ? `Removed: ${sentences[0]}. ${undoWords()}`
    : `Removed ${sentences.length} connections: ${sentences.join("; ")}. ${undoWords()}`;

/** Where the keyboard goes after a removal took the focused control with it. */
type RemovalFocus = {
  /** The row's place in reading order when it went. */
  readonly at: number;
  /** One row's X, or several rows from the foot. */
  readonly from: "x" | "foot";
  /** The wires whose departure is waited on; a cancelled removal never takes the keyboard. */
  readonly until: ReadonlyArray<string>;
};

/**
 * A seat's connections, from its bar: every wire that touches it, grouped by
 * the other end's region, searched by name and region path. One row is
 * removed at once by its own X, undone as on the canvas; several chosen are
 * removed together after a question in the foot that says how many; one
 * chosen goes as its X does. Add opens the connect search in the same pop,
 * and its close comes back here. Nothing is stored: every change is the
 * canvas's own wire change.
 *
 * The keyboard: the search takes it on open (Add, when the seat has no
 * connections), Down goes to the rows, the list keys walk them from their
 * checkboxes (Up on the first goes back to the search), and when the pop
 * closes the keyboard goes back to what opened it. Every removal keeps the
 * keyboard in the list, at the row that took the removed one's place.
 *
 * Each row is a line of its own, so a row can take more later.
 */
export function ConnectionsPanel({ nodeId, onClose }: { readonly nodeId: string; readonly onClose: () => void }) {
  useOverlayHold();
  const canvas = useCanvas(use$(state$.canvasName));
  const seat = canvas.nodes.get(asNodeId(nodeId));
  const seatName = seat ? titleOf(seat) : nodeId;
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  // The set as the last toggle left it: two presses in one batch build on each other, not on the last render.
  const chosenNow = useRef<ReadonlySet<string>>(chosen);
  chosenNow.current = chosen;
  const [asking, setAsking] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [spoken, setSpoken] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const footRemoveRef = useRef<HTMLButtonElement>(null);
  /** A removal whose focused control left the DOM with its row: where the keyboard goes once it shows. */
  const removalFocus = useRef<RemovalFocus | null>(null);
  /** A swap in the foot that took the focused control: where the keyboard goes next. */
  const footFocus = useRef<"cancel" | "remove" | "search" | null>(null);
  // Read as the pop opens, before the search takes the keyboard: the key that opened it.
  const [opener] = useState(() => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    const element = active instanceof HTMLElement && active !== document.body ? active : null;
    return { element, borrowed: openerBorrowedKeyboard() };
  });

  const all = useMemo(() => seatConnections(canvas, nodeId), [canvas, nodeId]);
  const shown = useMemo(() => matchConnections(all, search), [all, search]);
  const groups = useMemo(() => groupConnections(canvas, nodeId, shown), [canvas, nodeId, shown]);
  /** The rows in reading order, as the list keys walk them. */
  const ids = useMemo(() => groups.flatMap((group) => group.rows.map((row) => row.wireId)), [groups]);
  const nav = useListNav({ ids, selected: current, onSelect: setCurrent });

  // A chosen wire that left the canvas (removed here, undone, or elsewhere) no longer counts.
  const live = useMemo(() => new Set(all.map((row) => row.wireId)), [all]);
  const picked = [...chosen].filter((id) => live.has(id));
  // The question is only for several.
  const questioning = asking && picked.length > 1;

  // The pop takes the keyboard on open: the search, or Add when nothing is listed.
  useEffect(() => {
    if (!adding) claimFocus(searchRef.current ?? addRef.current, "open");
  }, [adding]);

  // The pop closed: the keyboard goes back to the key, unless the operator put it somewhere since.
  useEffect(() => () => returnKeyboardFrom(opener.element, opener.borrowed), [opener]);

  // A swap in the foot removed the control the operator pressed: the keyboard stays in the panel.
  useEffect(() => {
    const wanted = footFocus.current;
    if (wanted === null) return;
    footFocus.current = null;
    if (wanted === "cancel") claimFocus(cancelRef.current, "open");
    else if (wanted === "remove") claimFocus(footRemoveRef.current, "open");
    else claimFocus(searchRef.current ?? addRef.current, "open");
  }, [questioning, picked.length]);

  // A removal took the focused control with it: the keyboard goes to the row at that place.
  useEffect(() => {
    const wanted = removalFocus.current;
    if (wanted === null || wanted.until.some((id) => live.has(id))) return;
    removalFocus.current = null;
    if (!focusLost()) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-connection-row]") ?? [])];
    const next = rows[wanted.at];
    const previous = rows[wanted.at - 1];
    const rowControl = (row: HTMLElement | undefined): HTMLElement | null =>
      row?.querySelector<HTMLElement>('input[type="checkbox"]') ?? null;
    const rowRemove = (row: HTMLElement | undefined): HTMLElement | null =>
      row?.querySelector<HTMLElement>("button[data-row-remove]") ?? null;
    const target =
      wanted.from === "x"
        ? rowRemove(next) ?? rowRemove(previous)
        : rowControl(next);
    claimFocus(target ?? searchRef.current ?? addRef.current, "open");
  }, [all]);

  if (adding) {
    return <ConnectEditor nodeId={nodeId} onClose={() => setAdding(false)} />;
  }

  const toggle = (wireId: string): void => {
    const next = new Set(chosenNow.current);
    if (next.has(wireId)) next.delete(wireId);
    else next.add(wireId);
    chosenNow.current = next;
    setChosen(next);
    const count = [...next].filter((id) => live.has(id)).length;
    setSpoken(count === 0 ? "" : `${count} chosen`);
  };

  // One wire, or the chosen, go without a question (undo restores them); several asked first in the foot.
  const removeOne = (row: SeatConnection): void => {
    const intent: RemovalFocus = { at: Math.max(0, ids.indexOf(row.wireId)), from: "x", until: [row.wireId] };
    removalFocus.current = intent;
    void deleteEdges([row.wireId], { quiet: true }).then((removed) => {
      if (removed) setSpoken(removedWords([row.sentence]));
      else if (removalFocus.current === intent) removalFocus.current = null;
    });
  };

  const removeChosen = (): void => {
    const going = picked;
    const sentences = going.map((id) => all.find((row) => row.wireId === id)?.sentence ?? "").filter(Boolean);
    const first = Math.min(...going.map((id) => ids.indexOf(id)).filter((at) => at >= 0));
    const intent: RemovalFocus = { at: Number.isFinite(first) ? first : 0, from: "foot", until: going };
    removalFocus.current = intent;
    // The question stays while the task-impact question is up: a cancelled one keeps the chosen rows.
    void deleteEdges(going, { quiet: true }).then((removed) => {
      if (!removed) {
        if (removalFocus.current === intent) removalFocus.current = null;
        return;
      }
      setAsking(false);
      setChosen((was) => new Set([...was].filter((id) => !going.includes(id))));
      setSpoken(removedWords(sentences));
    });
  };

  const rowElement = (wireId: string | undefined): HTMLElement | null =>
    wireId === undefined ? null : listRef.current?.querySelector<HTMLElement>(`[data-wire-id="${escapeId(wireId)}"]`) ?? null;

  /** The row's own focusable control: its checkbox. */
  const rowControl = (wireId: string | undefined): HTMLElement | null =>
    wireId === undefined ? null : listRef.current?.querySelector<HTMLElement>(`[data-list-row="${escapeId(wireId)}"]`) ?? null;

  /**
   * Escape closes the question first, then the pop. Down in the search goes to
   * the first row; the list keys walk the rows, and a move up from the first
   * row goes back to the search.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (questioning) {
        footFocus.current = "remove";
        setAsking(false);
      } else onClose();
      return;
    }
    if (event.target === searchRef.current) {
      if (event.key !== "ArrowDown" || ids.length === 0) return;
      event.preventDefault();
      setCurrent(ids[0]!);
      claimFocus(rowControl(ids[0]), "gesture", { event: event.nativeEvent });
      return;
    }
    const onFirst = ids.length > 0 && rowElement(ids[0])?.contains(event.target as Node) === true;
    if (onFirst && listIntentOf(event.nativeEvent) === "previous" && searchRef.current) {
      event.preventDefault();
      claimFocus(searchRef.current, "gesture", { event: event.nativeEvent });
      return;
    }
    nav.onKeyDown(event);
  };

  const count = all.length;
  return (
    <div
      className="connections-panel"
      data-testid="connections-panel"
      role="dialog"
      aria-label={`Connections, ${seatName}`}
      onKeyDown={onKeyDown}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="connections-status">
        {spoken}
      </span>
      <div className="connections-panel__head">
        <div className="connections-panel__title">
          <Eyebrow>{`Connections, ${seatName}`}</Eyebrow>
          <span className="connections-panel__count">
            {count}
            <span className="sr-only"> connections</span>
          </span>
          <Button ref={addRef} size="sm" variant="chrome" className="connections-panel__add" onClick={() => setAdding(true)} data-testid="connections-add">
            Add
          </Button>
        </div>
        {count > 0 ? (
          <label className="connections-panel__search">
            <Search size={13} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search connections"
              placeholder="Search connections"
              spellCheck={false}
              value={search}
              data-testid="connections-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        ) : null}
      </div>

      <div className="connections-panel__list" ref={listRef} data-testid="connections-list">
        {count === 0 ? (
          <div className="connections-panel__empty">
            <span>No connections yet</span>
            <Button size="sm" variant="chrome" aria-label="Add a connection" onClick={() => setAdding(true)}>Add</Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="connections-panel__empty">
            <span>No connection matches</span>
            <Button size="sm" variant="subtle" onClick={() => setSearch("")}>Clear</Button>
          </div>
        ) : (
          groups.map((group) => (
            <div
              key={group.regionId ?? "open-field"}
              className="connections-panel__group"
              style={{ "--connections-region": group.color ? accentColor(group.color) : "var(--color-steel)" } as CSSProperties}
            >
              <header className="connections-panel__group-head">
                <span className="connections-panel__swatch" aria-hidden />
                <span className="connections-panel__group-name">{group.name}</span>
                {group.outer.length > 0 ? <span className="connections-panel__group-path">in {group.outer.join(" / ")}</span> : null}
                <span className="connections-panel__rule" aria-hidden />
                <span className="connections-panel__group-count">{group.rows.length}</span>
              </header>
              <div
                role="list"
                aria-label={`${group.name}, ${group.rows.length}${group.outer.length > 0 ? `, in ${group.outer.join(" / ")}` : ""}`}
              >
                {group.rows.map((row) => (
                  <ConnectionRow
                    key={row.wireId}
                    row={row}
                    nav={nav.rowProps(row.wireId)}
                    onFocus={() => setCurrent(row.wireId)}
                    chosen={chosen.has(row.wireId)}
                    onToggle={() => toggle(row.wireId)}
                    onRemove={() => removeOne(row)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {picked.length > 0 ? (
        <div className="connections-panel__foot" data-testid="connections-foot">
          {questioning ? (
            <>
              <span className="connections-panel__ask" role="alert">{`Remove ${picked.length} connections?`}</span>
              <Button
                ref={cancelRef}
                size="sm"
                variant="subtle"
                onClick={() => {
                  footFocus.current = "remove";
                  setAsking(false);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={removeChosen} data-testid="connections-remove-confirm">
                {removeLabel(picked.length)}
              </Button>
            </>
          ) : (
            <>
              <span className="connections-panel__chosen">{`${picked.length} chosen`}</span>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  footFocus.current = "search";
                  setChosen(new Set());
                  setSpoken("");
                }}
              >
                Clear
              </Button>
              <Button
                ref={footRemoveRef}
                size="sm"
                variant="danger"
                data-testid="connections-remove-chosen"
                onClick={() => {
                  if (picked.length > 1) {
                    footFocus.current = "cancel";
                    setAsking(true);
                  } else removeChosen();
                }}
              >
                {removeLabel(picked.length)}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One wire: its other end, and the wire as a sentence with which way it goes. */
function ConnectionRow({
  row,
  nav,
  onFocus,
  chosen,
  onToggle,
  onRemove,
}: {
  readonly row: SeatConnection;
  readonly nav: ReturnType<ReturnType<typeof useListNav>["rowProps"]>;
  readonly onFocus: () => void;
  readonly chosen: boolean;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  const Way = WAY_ICON[row.way];
  return (
    <div
      role="listitem"
      onFocus={onFocus}
      className="connections-panel__row"
      data-connection-row
      data-selected={chosen ? "true" : undefined}
      data-testid="connections-row"
      data-wire-id={row.wireId}
    >
      <label className="connections-panel__check-hit">
        <input
          {...nav}
          type="checkbox"
          className="connections-panel__check"
          checked={chosen}
          aria-label={`Choose: ${row.sentence}`}
          onChange={onToggle}
        />
      </label>
      <span className="connections-panel__lines">
        <span className="connections-panel__line">
          <span className="connections-panel__mark" aria-hidden>
            {row.other.kind === "agent" ? (
              <AgentPortrait identity={row.other.id} size={20} frame="round" outline={false} badge={false} />
            ) : (
              <KindMark node={row.other} className="connections-panel__kind" iconSize={12} />
            )}
          </span>
          <span className="connections-panel__name">{row.otherName}</span>
          {row.path ? <span className="connections-panel__path">{row.path}</span> : null}
        </span>
        <span className="connections-panel__sentence">
          <Way size={12} aria-hidden className="connections-panel__way" />
          <span className="connections-panel__sentence-text">{row.sentence}</span>
        </span>
      </span>
      <IconButton
        size="xs"
        tone="danger"
        data-row-remove
        aria-label={`Remove: ${row.sentence}`}
        title={`Remove: ${row.sentence}`}
        onClick={onRemove}
      >
        <X size={12} aria-hidden />
      </IconButton>
    </div>
  );
}
