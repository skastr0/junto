import {
  memo,
  useCallback,
  useEffect,
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
import { releaseFocus } from "../../lib/focus-ownership";

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
 */
export function ArtifactSheetEditor({
  grid,
  readOnly = false,
  onPatch,
  onCommentCells,
}: {
  readonly grid: SheetGrid;
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
  const [refusal, setRefusal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
  }, [commitCell]);

  const onCellSelect = useCallback((at: CellAt, extend: boolean) => {
    setSelection((current) =>
      extend && current !== null ? { anchor: current.anchor, focus: at } : { anchor: at, focus: at },
    );
  }, []);

  const onDeleteRow = useCallback(
    (rowId: string) => {
      setSelection(null);
      emit([{ op: "row.remove", rowId }]);
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
  const commentRange = liveSelection ? selectionRange(liveSelection) : null;

  const range = visibleSheetRowRange(draft.rows.length, scrollTop, viewportHeight);
  const topSpacer = range.start * SHEET_ROW_HEIGHT_PX;
  const bottomSpacer = Math.max(0, (draft.rows.length - range.end) * SHEET_ROW_HEIGHT_PX);
  const visibleRows = draft.rows.slice(range.start, range.end);

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
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <table style={{ "--sheet-columns": draft.columns.length } as CSSProperties}>
          <thead>
            <tr>
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
          <span className="junto-artifact-sheet__note">
            {`${String(draft.rows.length)} × ${String(draft.columns.length)}. Cells are plain text; shift-click to select a range.`}
          </span>
        )}
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
  selection,
  onCellChange,
  onCellDone,
  onCellSelect,
  onDeleteRow,
}: {
  readonly row: SheetGrid["rows"][number];
  readonly index: number;
  readonly columns: SheetGrid["columns"];
  readonly numericByColumn: Readonly<Record<string, boolean>>;
  readonly readOnly: boolean;
  /** The cell being typed in this row, if any. */
  readonly cellDraft: CellDraft | null;
  /** The selection, only when it covers this row. */
  readonly selection: Selection | null;
  readonly onCellChange: (rowId: string, columnId: string, value: string) => void;
  readonly onCellDone: () => void;
  readonly onCellSelect: (at: CellAt, extend: boolean) => void;
  readonly onDeleteRow: (rowId: string) => void;
}) {
  const rowStyle = { height: SHEET_ROW_HEIGHT_PX } satisfies CSSProperties;
  return (
    <tr style={rowStyle}>
      <td className="junto-artifact-sheet__gutter">
        <div className="junto-artifact-sheet__gutter-inner">
          <span>{index + 1}</span>
          {readOnly ? null : (
            <IconButton
              aria-label={`Delete row ${String(index + 1)}`}
              title="Delete row"
              tone="danger"
              onClick={() => onDeleteRow(row.id)}
            >
              <Trash2 size={11} />
            </IconButton>
          )}
        </div>
      </td>
      {columns.map((column, columnIndex) => {
        const typing = cellDraft?.columnId === column.id ? cellDraft : null;
        return (
          <td
            key={column.id}
            data-selected={inSelection(selection, index, columnIndex) ? "true" : undefined}
          >
            <input
              aria-label={`${column.name || column.id} row ${String(index + 1)}`}
              data-cell={`${sheetColumnLetter(columnIndex)}${String(index + 1)}`}
              value={typing ? typing.value : (row.cells[column.id] ?? "")}
              data-numeric={numericByColumn[column.id] ? "true" : undefined}
              readOnly={readOnly}
              onMouseDown={(event: ReactMouseEvent<HTMLInputElement>) => {
                if (event.shiftKey) {
                  event.preventDefault();
                  onCellSelect({ row: index, column: columnIndex }, true);
                }
              }}
              onFocus={() => onCellSelect({ row: index, column: columnIndex }, false)}
              onChange={(event) => onCellChange(row.id, column.id, event.target.value)}
              onBlur={onCellDone}
              onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") onCellDone();
              }}
            />
          </td>
        );
      })}
    </tr>
  );
});
