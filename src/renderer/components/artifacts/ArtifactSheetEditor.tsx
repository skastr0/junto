import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Result } from "effect";
import { Copy, MessageSquare, Plus, Trash2 } from "lucide-react";
import { ulid } from "ulid";
import { applySheetPatch, type SheetPatch } from "@shared/artifact";
import type { SheetGrid } from "@shared/model/sheet";
import {
  isNumericColumn,
  sheetColumnLetter,
  sheetToMarkdown,
  visibleSheetRowRange,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  SHEET_ROW_HEIGHT_PX,
} from "@shared/sheet";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import "./artifact-sheet.css";
import { claimFocus, releaseFocus } from "../../lib/focus-ownership";

/** Typing settles into one `cell` patch after this pause, or on blur and Enter. */
export const SHEET_CELL_DEBOUNCE_MS = 400;

type CellAt = { readonly row: number; readonly column: number };
type Selection = { readonly anchor: CellAt; readonly focus: CellAt };
type CellDraft = { readonly rowId: string; readonly columnId: string; readonly value: string };
type ColumnDraft = { readonly columnId: string; readonly value: string };

/** Ids the writer mints for new rows and columns: unique without reading the grid. */
export const mintSheetRowId = (): string => `r${ulid()}`;
export const mintSheetColumnId = (): string => `c${ulid()}`;

/** A1 range for a selection, top left first; one cell reads as `B2`. */
export const selectionRange = (selection: Selection): string => {
  const top = Math.min(selection.anchor.row, selection.focus.row);
  const bottom = Math.max(selection.anchor.row, selection.focus.row);
  const left = Math.min(selection.anchor.column, selection.focus.column);
  const right = Math.max(selection.anchor.column, selection.focus.column);
  const from = `${sheetColumnLetter(left)}${String(top + 1)}`;
  const to = `${sheetColumnLetter(right)}${String(bottom + 1)}`;
  return from === to ? from : `${from}:${to}`;
};

const cellName = (at: CellAt): string => `${sheetColumnLetter(at.column)}${String(at.row + 1)}`;
const sameCell = (a: CellAt | null, b: CellAt): boolean => a !== null && a.row === b.row && a.column === b.column;

/** Arrow keys and the step each one takes. */
const STEPS: Readonly<Record<string, CellAt>> = {
  ArrowUp: { row: -1, column: 0 },
  ArrowDown: { row: 1, column: 0 },
  ArrowLeft: { row: 0, column: -1 },
  ArrowRight: { row: 0, column: 1 },
};

/** Which sides of a selected cell are the range's edge, so the range is drawn as one outlined block. */
const edgesOf = (selection: Selection, row: number, column: number) => ({
  top: row === Math.min(selection.anchor.row, selection.focus.row),
  bottom: row === Math.max(selection.anchor.row, selection.focus.row),
  left: column === Math.min(selection.anchor.column, selection.focus.column),
  right: column === Math.max(selection.anchor.column, selection.focus.column),
});

const inSelection = (selection: Selection | null, row: number, column: number): boolean => {
  if (selection === null) return false;
  const { anchor, focus } = selection;
  return (
    row >= Math.min(anchor.row, focus.row) &&
    row <= Math.max(anchor.row, focus.row) &&
    column >= Math.min(anchor.column, focus.column) &&
    column <= Math.max(anchor.column, focus.column)
  );
};

/** Patches folded over a grid; a patch that does not apply leaves it as it was. */
const applyLocal = (grid: SheetGrid, patches: ReadonlyArray<SheetPatch>): SheetGrid =>
  patches.reduce((current, patch) => {
    const next = applySheetPatch(current, patch);
    return Result.isSuccess(next) ? next.success : current;
  }, grid);

/**
 * The artifact sheet editor: the sheet node's virtualized grid of text
 * inputs, writing through sheet patches instead of whole grids. Every user
 * action is one or more patches handed to `onPatch`; the grid shows them at
 * once and re-syncs to the `grid` prop whenever the host hands a new one.
 * A refusal puts the grid back to the last one the host handed and says why.
 *
 * The grid is one Tab stop, the active cell. Arrows move it and Shift+arrow
 * extends the selection; Enter or F2 edits the cell, and so does typing a
 * character, which starts the edit with it. In an edit Enter commits and
 * moves down, Tab commits and moves across, Escape puts the cell back.
 * Delete or Backspace clears the cell, Cmd+Backspace removes its row.
 */
export function ArtifactSheetEditor({
  grid,
  readOnly = false,
  onPatch,
  onCommentCells,
  title,
}: {
  readonly grid: SheetGrid;
  /** The artifact's title, so two open sheets read apart. */
  readonly title?: string;
  readonly readOnly?: boolean;
  /** Resolves with the refusal line, or null when the patches landed. */
  readonly onPatch: (patches: ReadonlyArray<SheetPatch>) => Promise<string | null>;
  readonly onCommentCells?: (range: string) => void;
}) {
  const [draft, setDraft] = useState<SheetGrid>(grid);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const gridRef = useRef(grid);
  gridRef.current = grid;
  // A new grid from the host is the truth: drop the optimistic view.
  useEffect(() => {
    setDraft(grid);
    draftRef.current = grid;
  }, [grid]);

  const [cellDraft, setCellDraft] = useState<CellDraft | null>(null);
  const cellDraftRef = useRef(cellDraft);
  cellDraftRef.current = cellDraft;
  const [columnDraft, setColumnDraft] = useState<ColumnDraft | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  /** The cell in an edit, if any; every other cell only navigates. */
  const [editing, setEditing] = useState<CellAt | null>(null);
  /** What the edited cell held when the edit began, for Escape. */
  const editOrigin = useRef("");
  /** A cell the keyboard moved to: focused once its row is drawn. */
  const pendingFocus = useRef<{ readonly at: CellAt; readonly tries: number; readonly event?: Event } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** A change nothing on screen shows under the caret (a row removed, a cell cleared), said aloud. */
  const [said, setSaid] = useState<string | null>(null);
  const hintId = useId();
  const typingTimer = useRef<number | null>(null);
  const copyTimer = useRef<number | null>(null);
  // One write in flight at a time, so the host sees patches in the order made.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(
    () => () => {
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const sync = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft.rows.length, draft.columns.length]);

  const emit = useCallback(
    (patches: ReadonlyArray<SheetPatch>) => {
      if (readOnly || patches.length === 0) return;
      const next = applyLocal(draftRef.current, patches);
      setDraft(next);
      draftRef.current = next;
      setRefusal(null);
      queueRef.current = queueRef.current.then(async () => {
        const line = await onPatch(patches).catch((error: unknown) =>
          error instanceof Error ? error.message : "The sheet could not be written.",
        );
        if (line === null) return;
        setRefusal(line);
        setDraft(gridRef.current);
        draftRef.current = gridRef.current;
      });
    },
    [onPatch, readOnly],
  );

  const commitCell = useCallback(() => {
    if (typingTimer.current !== null) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    const pending = cellDraftRef.current;
    if (pending === null) return;
    const row = draftRef.current.rows.find((candidate) => candidate.id === pending.rowId);
    if (!row) return;
    const current = row.cells[pending.columnId] ?? "";
    // Blank text clears a cell, so blank over blank is no change.
    const same = pending.value === current || (pending.value.trim() === "" && current === "");
    if (same) return;
    emit([{ op: "cell", rowId: pending.rowId, columnId: pending.columnId, value: pending.value }]);
  }, [emit]);

  const onCellChange = useCallback(
    (rowId: string, columnId: string, value: string) => {
      const next = { rowId, columnId, value };
      setCellDraft(next);
      cellDraftRef.current = next;
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(commitCell, SHEET_CELL_DEBOUNCE_MS);
    },
    [commitCell],
  );

  const onCellDone = useCallback(() => {
    commitCell();
    setCellDraft(null);
    cellDraftRef.current = null;
    setEditing(null);
  }, [commitCell]);

  const onCellSelect = useCallback((at: CellAt, extend: boolean) => {
    setSelection((current) =>
      extend && current !== null ? { anchor: current.anchor, focus: at } : { anchor: at, focus: at },
    );
    if (extend) pendingFocus.current = { at, tries: 0 };
  }, []);

  /** Focus landed on a cell: it is the active one, and a range that already ends there stays. */
  const onCellFocus = useCallback((at: CellAt) => {
    setSelection((current) => (current !== null && sameCell(current.focus, at) ? current : { anchor: at, focus: at }));
  }, []);

  const onDeleteRow = useCallback(
    (rowId: string) => {
      const at = draftRef.current.rows.findIndex((row) => row.id === rowId);
      setSelection(null);
      emit([{ op: "row.remove", rowId }]);
      if (at !== -1) setSaid(`Row ${String(at + 1)} removed`);
    },
    [emit],
  );

  const commitColumnName = (): void => {
    const pending = columnDraft;
    setColumnDraft(null);
    if (pending === null) return;
    const name = pending.value.trim();
    const column = draftRef.current.columns.find((candidate) => candidate.id === pending.columnId);
    // A column always has a name: blank puts the old one back.
    if (!column || name.length === 0 || name === column.name) return;
    emit([{ op: "column.rename", columnId: pending.columnId, name }]);
  };

  const addRow = (): void => emit([{ op: "row.add", rowId: mintSheetRowId() }]);
  const addColumn = (): void =>
    emit([
      {
        op: "column.add",
        columnId: mintSheetColumnId(),
        name: `Column ${sheetColumnLetter(draftRef.current.columns.length)}`,
      },
    ]);
  const removeColumn = (columnId: string): void => {
    setSelection(null);
    emit([{ op: "column.remove", columnId }]);
  };

  /** Move the active cell by a step, kept inside the grid; with `extend` the selection grows. */
  const move = (from: CellAt, step: CellAt, extend: boolean, event: Event): boolean => {
    const at = {
      row: Math.min(Math.max(from.row + step.row, 0), draftRef.current.rows.length - 1),
      column: Math.min(Math.max(from.column + step.column, 0), draftRef.current.columns.length - 1),
    };
    if (sameCell(from, at)) return false;
    setSaid(null);
    setSelection((current) => (extend && current !== null ? { anchor: current.anchor, focus: at } : { anchor: at, focus: at }));
    pendingFocus.current = { at, tries: 0, event };
    return true;
  };

  const startEdit = (at: CellAt, seed: string | null): void => {
    const row = draftRef.current.rows[at.row];
    const column = draftRef.current.columns[at.column];
    if (readOnly || !row || !column) return;
    editOrigin.current = row.cells[column.id] ?? "";
    setEditing(at);
    if (seed !== null) onCellChange(row.id, column.id, seed);
  };

  /** A double-click edits; read through a ref so the memoized rows keep one prop. */
  const startEditRef = useRef<(at: CellAt) => void>(() => {});
  startEditRef.current = (at) => startEdit(at, null);

  /** Escape in an edit: nothing typed lands, and a value the pause already sent is put back. */
  const cancelEdit = (at: CellAt): void => {
    if (typingTimer.current !== null) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    setCellDraft(null);
    cellDraftRef.current = null;
    setEditing(null);
    const row = draftRef.current.rows[at.row];
    const column = draftRef.current.columns[at.column];
    if (!row || !column) return;
    if ((row.cells[column.id] ?? "") !== editOrigin.current) {
      emit([{ op: "cell", rowId: row.id, columnId: column.id, value: editOrigin.current }]);
    }
  };

  const keyRef = useRef<(event: ReactKeyboardEvent<HTMLInputElement>, at: CellAt) => void>(() => {});
  keyRef.current = (event, at) => {
    const mod = event.metaKey || event.ctrlKey || event.altKey;
    if (sameCell(editing, at)) {
      if (event.key === "Enter") {
        event.preventDefault();
        onCellDone();
        move(at, { row: 1, column: 0 }, false, event.nativeEvent);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelEdit(at);
      } else if (event.key === "Tab") {
        onCellDone();
        if (move(at, { row: 0, column: event.shiftKey ? -1 : 1 }, false, event.nativeEvent)) event.preventDefault();
      }
      return;
    }
    if (event.nativeEvent.isComposing) return;
    const step = STEPS[event.key];
    if (step !== undefined && !mod) {
      event.preventDefault();
      move(liveSelectionRef.current?.focus ?? at, step, event.shiftKey, event.nativeEvent);
    } else if ((event.key === "Enter" || event.key === "F2") && !mod) {
      event.preventDefault();
      startEdit(at, null);
    } else if (event.key === "Tab" && !mod) {
      if (move(at, { row: 0, column: event.shiftKey ? -1 : 1 }, false, event.nativeEvent)) event.preventDefault();
    } else if (event.key === "Backspace" && event.metaKey && !readOnly) {
      event.preventDefault();
      const row = draftRef.current.rows[at.row];
      if (row) onDeleteRow(row.id);
    } else if ((event.key === "Delete" || event.key === "Backspace") && !mod && !readOnly) {
      event.preventDefault();
      const row = draftRef.current.rows[at.row];
      const column = draftRef.current.columns[at.column];
      if (row && column && (row.cells[column.id] ?? "") !== "") {
        emit([{ op: "cell", rowId: row.id, columnId: column.id, value: "" }]);
        setSaid(`Cleared ${cellName(at)}`);
      }
    } else if (event.key.length === 1 && !mod && !readOnly) {
      event.preventDefault();
      startEdit(at, event.key);
    }
  };
  const onCellKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, at: CellAt) => keyRef.current(event, at),
    [],
  );

  // The cell the keyboard moved to takes focus once drawn; a row outside the
  // drawn window scrolls in first.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    const scroller = scrollerRef.current;
    if (pending === null || scroller === null) return;
    const target = scroller.querySelector<HTMLInputElement>(`[data-cell="${cellName(pending.at)}"]`);
    if (target !== null) {
      pendingFocus.current = null;
      claimFocus(target, "gesture", { preventScroll: true, ...(pending.event ? { event: pending.event } : {}) });
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (pending.tries > 1) {
      pendingFocus.current = null;
      return;
    }
    pendingFocus.current = { ...pending, tries: pending.tries + 1 };
    scroller.scrollTop = Math.max(0, (pending.at.row + 1) * SHEET_ROW_HEIGHT_PX - scroller.clientHeight / 2);
    setScrollTop(scroller.scrollTop);
  });

  // An edit puts the caret after the text; a seeded edit already ends there.
  useLayoutEffect(() => {
    if (editing === null) return;
    const target = scrollerRef.current?.querySelector<HTMLInputElement>(`[data-cell="${cellName(editing)}"]`);
    if (target && document.activeElement === target) target.setSelectionRange(target.value.length, target.value.length);
  }, [editing]);

  const copyMarkdown = (): void => {
    void navigator.clipboard?.writeText(sheetToMarkdown(draft)).then(() => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1_200);
    });
  };

  const atColumnLimit = draft.columns.length >= SHEET_MAX_COLUMNS;
  const atRowLimit = draft.rows.length >= SHEET_MAX_ROWS;
  const numericByColumn = useMemo(() => {
    const flags: Record<string, boolean> = {};
    for (const column of draft.columns) {
      flags[column.id] = isNumericColumn(draft, column.id);
    }
    return flags;
  }, [draft]);

  // A selection outside the grid (rows or columns removed) is no selection.
  const liveSelection =
    selection !== null &&
    Math.max(selection.anchor.row, selection.focus.row) < draft.rows.length &&
    Math.max(selection.anchor.column, selection.focus.column) < draft.columns.length
      ? selection
      : null;
  const liveSelectionRef = useRef(liveSelection);
  liveSelectionRef.current = liveSelection;
  const commentRange = liveSelection ? selectionRange(liveSelection) : null;
  /** The grid's one Tab stop. */
  const active = liveSelection?.focus ?? { row: 0, column: 0 };

  const range = visibleSheetRowRange(draft.rows.length, scrollTop, viewportHeight);
  const topSpacer = range.start * SHEET_ROW_HEIGHT_PX;
  const bottomSpacer = Math.max(0, (draft.rows.length - range.end) * SHEET_ROW_HEIGHT_PX);
  const visibleRows = draft.rows.slice(range.start, range.end);
  const activeDrawn = active.row >= range.start && active.row < range.end;

  return (
    <div
      className="junto-artifact-sheet flex h-full min-h-0 flex-col"
      data-testid="artifact-sheet"
      data-readonly={readOnly ? "true" : undefined}
    >
      <div
        className="junto-artifact-sheet__grid"
        data-testid="artifact-sheet-grid"
        data-row-start={String(range.start)}
        data-row-end={String(range.end)}
        data-row-count={String(draft.rows.length)}
        ref={scrollerRef}
        data-pane-entry=""
        // The Tab stop while the active cell's row is scrolled out of the drawn window.
        tabIndex={activeDrawn ? -1 : 0}
        onFocus={(event) => {
          if (event.target === event.currentTarget) pendingFocus.current = { at: active, tries: 0 };
          setScrollTop(event.currentTarget.scrollTop);
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table
          role="grid"
          aria-label={title ? `${title}, sheet` : "Sheet"}
          aria-describedby={hintId}
          aria-multiselectable="true"
          aria-rowcount={draft.rows.length + 1}
          aria-colcount={draft.columns.length + 1}
          style={{ "--sheet-columns": draft.columns.length } as CSSProperties}
        >
          <thead>
            <tr aria-rowindex={1}>
              <th className="junto-artifact-sheet__gutter" aria-hidden />
              {draft.columns.map((column, index) => (
                <th key={column.id}>
                  <div className="junto-artifact-sheet__head">
                    <span className="junto-artifact-sheet__letter">{sheetColumnLetter(index)}</span>
                    <input
                      aria-label={`Column name ${column.name || column.id}`}
                      value={columnDraft?.columnId === column.id ? columnDraft.value : column.name}
                      placeholder="column"
                      readOnly={readOnly}
                      onChange={(event) =>
                        setColumnDraft({ columnId: column.id, value: event.target.value })
                      }
                      onBlur={commitColumnName}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") releaseFocus(event.currentTarget, "gesture");
                        if (event.key === "Escape") setColumnDraft(null);
                      }}
                    />
                    {readOnly ? null : (
                      <IconButton
                        aria-label={`Delete column ${column.name || column.id}`}
                        title="Delete column"
                        tone="danger"
                        onClick={() => removeColumn(column.id)}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topSpacer > 0 ? (
              <tr aria-hidden className="junto-artifact-sheet__spacer">
                <td
                  colSpan={draft.columns.length + 1}
                  style={{ height: topSpacer, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
            {visibleRows.map((row, offset) => {
              const index = range.start + offset;
              return (
                <ArtifactSheetRow
                  key={row.id}
                  row={row}
                  index={index}
                  columns={draft.columns}
                  numericByColumn={numericByColumn}
                  readOnly={readOnly}
                  cellDraft={cellDraft?.rowId === row.id ? cellDraft : null}
                  activeColumn={active.row === index ? active.column : null}
                  editingColumn={editing?.row === index ? editing.column : null}
                  selection={
                    liveSelection !== null &&
                    index >= Math.min(liveSelection.anchor.row, liveSelection.focus.row) &&
                    index <= Math.max(liveSelection.anchor.row, liveSelection.focus.row)
                      ? liveSelection
                      : null
                  }
                  onCellChange={onCellChange}
                  onCellDone={onCellDone}
                  onCellSelect={onCellSelect}
                  onCellFocus={onCellFocus}
                  onCellKeyDown={onCellKeyDown}
                  onStartEdit={startEditRef}
                  onDeleteRow={onDeleteRow}
                />
              );
            })}
            {bottomSpacer > 0 ? (
              <tr aria-hidden className="junto-artifact-sheet__spacer">
                <td
                  colSpan={draft.columns.length + 1}
                  style={{ height: bottomSpacer, padding: 0, border: 0 }}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="junto-artifact-sheet__actions">
        {readOnly ? null : (
          <>
            <Button
              size="xs"
              variant="chrome"
              onClick={addRow}
              disabled={atRowLimit}
              title={atRowLimit ? `A sheet holds ${String(SHEET_MAX_ROWS)} rows` : "Add a row"}
            >
              <Plus size={11} aria-hidden /> Row
            </Button>
            <Button
              size="xs"
              variant="chrome"
              onClick={addColumn}
              disabled={atColumnLimit}
              title={
                atColumnLimit
                  ? `A sheet holds ${String(SHEET_MAX_COLUMNS)} columns`
                  : "Add a column"
              }
            >
              <Plus size={11} aria-hidden /> Column
            </Button>
          </>
        )}
        {onCommentCells ? (
          <Button
            size="xs"
            variant="chrome"
            data-testid="artifact-sheet-comment"
            disabled={commentRange === null}
            title={commentRange ? `Comment on ${commentRange}` : "Select cells to comment on"}
            // Keep the cell's focus: the click must not clear the selection first.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (commentRange !== null) onCommentCells(commentRange);
            }}
          >
            <MessageSquare size={11} aria-hidden /> {commentRange ? `Comment ${commentRange}` : "Comment"}
          </Button>
        ) : null}
        <IconButton
          aria-label="Copy as markdown table"
          title={copied ? "Copied" : "Copy as markdown table"}
          size="sm"
          onClick={copyMarkdown}
        >
          <Copy size={12} />
        </IconButton>
        {refusal ? (
          <span className="junto-artifact-sheet__refusal" role="status">
            {refusal}
          </span>
        ) : (
          <span className="junto-artifact-sheet__note" id={hintId}>
            {`${String(draft.rows.length)} × ${String(draft.columns.length)}. Cells are plain text. Enter edits, shift and arrows select a range.`}
          </span>
        )}
        <span className="sr-only" role="status" aria-live="polite" data-testid="artifact-sheet-status">
          {copied ? "Copied as a markdown table" : editing !== null ? `Editing ${cellName(editing)}` : (said ?? "")}
        </span>
      </div>
    </div>
  );
}

const ArtifactSheetRow = memo(function ArtifactSheetRow({
  row,
  index,
  columns,
  numericByColumn,
  readOnly,
  cellDraft,
  activeColumn,
  editingColumn,
  selection,
  onCellChange,
  onCellDone,
  onCellSelect,
  onCellFocus,
  onCellKeyDown,
  onStartEdit,
  onDeleteRow,
}: {
  readonly row: SheetGrid["rows"][number];
  readonly index: number;
  readonly columns: SheetGrid["columns"];
  readonly numericByColumn: Readonly<Record<string, boolean>>;
  readonly readOnly: boolean;
  /** The cell being typed in this row, if any. */
  readonly cellDraft: CellDraft | null;
  /** The column of the grid's Tab stop, when it is in this row. */
  readonly activeColumn: number | null;
  /** The column in an edit, when it is in this row. */
  readonly editingColumn: number | null;
  /** The selection, only when it covers this row. */
  readonly selection: Selection | null;
  readonly onCellChange: (rowId: string, columnId: string, value: string) => void;
  readonly onCellDone: () => void;
  readonly onCellSelect: (at: CellAt, extend: boolean) => void;
  readonly onCellFocus: (at: CellAt) => void;
  readonly onCellKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>, at: CellAt) => void;
  readonly onStartEdit: { readonly current: (at: CellAt) => void };
  readonly onDeleteRow: (rowId: string) => void;
}) {
  const rowStyle = { height: SHEET_ROW_HEIGHT_PX } satisfies CSSProperties;
  return (
    <tr style={rowStyle} aria-rowindex={index + 2}>
      <th scope="row" className="junto-artifact-sheet__gutter">
        <div className="junto-artifact-sheet__gutter-inner">
          <span>{index + 1}</span>
          {readOnly ? null : (
            // Off the Tab order: the grid is one stop, and Cmd+Backspace removes the active row.
            <IconButton
              aria-label={`Delete row ${String(index + 1)}`}
              title="Delete row"
              tone="danger"
              tabIndex={-1}
              onClick={() => onDeleteRow(row.id)}
            >
              <Trash2 size={11} />
            </IconButton>
          )}
        </div>
      </th>
      {columns.map((column, columnIndex) => {
        const typing = cellDraft?.columnId === column.id ? cellDraft : null;
        const at = { row: index, column: columnIndex };
        const selected = inSelection(selection, index, columnIndex);
        const edge = selected && selection !== null ? edgesOf(selection, index, columnIndex) : null;
        const inEdit = editingColumn === columnIndex;
        return (
          <td
            key={column.id}
            aria-selected={selected}
            data-selected={selected ? "true" : undefined}
            data-edge-top={edge?.top ? "" : undefined}
            data-edge-right={edge?.right ? "" : undefined}
            data-edge-bottom={edge?.bottom ? "" : undefined}
            data-edge-left={edge?.left ? "" : undefined}
          >
            <input
              aria-label={`${column.name || column.id} row ${String(index + 1)}`}
              data-cell={`${sheetColumnLetter(columnIndex)}${String(index + 1)}`}
              data-editing={inEdit ? "true" : undefined}
              tabIndex={activeColumn === columnIndex ? 0 : -1}
              value={typing ? typing.value : (row.cells[column.id] ?? "")}
              data-numeric={numericByColumn[column.id] ? "true" : undefined}
              // Outside an edit a cell only navigates: keys move, they do not type.
              readOnly={readOnly || !inEdit}
              onMouseDown={(event: ReactMouseEvent<HTMLInputElement>) => {
                if (event.shiftKey) {
                  event.preventDefault();
                  onCellSelect(at, true);
                }
              }}
              onDoubleClick={() => onStartEdit.current(at)}
              onFocus={() => onCellFocus(at)}
              onChange={(event) => onCellChange(row.id, column.id, event.target.value)}
              onBlur={onCellDone}
              onKeyDown={(event) => onCellKeyDown(event, at)}
            />
          </td>
        );
      })}
    </tr>
  );
});
