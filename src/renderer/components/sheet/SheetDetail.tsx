import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Copy, Plus, Trash2, X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import {
  addSheetColumn,
  addSheetRow,
  emptySheet,
  isNumericColumn,
  removeSheetColumn,
  removeSheetRow,
  renameSheetColumn,
  setSheetCell,
  sheetToMarkdown,
  visibleSheetRowRange,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  SHEET_ROW_HEIGHT_PX,
  type EtherSheet,
} from "@shared/sheet";
import { FocusSurface } from "../FocusSurface";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { registerCanvasDraftCommit } from "../../lib/canvas-editor-flush";
import {
  flushNodeSheetTyping,
  setNodeSheet,
  setNodeSheetTyping,
} from "../../lib/mutations";
import "./sheet.css";

/**
 * The sheet editor: a virtualized grid of text inputs. Typing lives in a
 * local draft so the canvas document (and React Flow) is not reminted on
 * every keystroke. Coalesced writes still land on the node — there is no
 * save button because there is no second durable copy of the data.
 */
export function SheetDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const rawText = node.type === "text" ? node.text : "";
  const title = rawText.split("\n")[0]?.trim() || "Sheet";
  const stored = node.ether?.sheet;
  const [draft, setDraft] = useState<EtherSheet>(() => stored ?? emptySheet());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const typingTimer = useRef<number | null>(null);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  useEffect(() => {
    const el = gridRef.current;
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

  const flushCanvas = useCallback(() => {
    if (typingTimer.current !== null) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    setNodeSheet(node.id, draftRef.current);
    flushNodeSheetTyping(node.id);
  }, [node.id]);

  const commitNow = useCallback(
    (next: EtherSheet) => {
      if (typingTimer.current !== null) {
        window.clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
      flushNodeSheetTyping(node.id);
      setNodeSheet(node.id, next);
    },
    [node.id],
  );

  const scheduleTyping = useCallback(() => {
    if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = null;
      setNodeSheetTyping(node.id, draftRef.current);
    }, 120);
  }, [node.id]);

  useEffect(() => {
    return registerCanvasDraftCommit(() => {
      flushCanvas();
    });
  }, [flushCanvas]);

  useEffect(
    () => () => {
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
      setNodeSheet(node.id, draftRef.current);
      flushNodeSheetTyping(node.id);
    },
    [node.id],
  );

  const apply = useCallback(
    (next: EtherSheet, mode: "typing" | "structure") => {
      setDraft(next);
      draftRef.current = next;
      if (mode === "typing") scheduleTyping();
      else commitNow(next);
    },
    [commitNow, scheduleTyping],
  );

  const onCell = useCallback(
    (rowId: string, columnId: string, value: string) => {
      apply(setSheetCell(draftRef.current, rowId, columnId, value), "typing");
    },
    [apply],
  );

  const onDeleteRow = useCallback(
    (rowId: string) => {
      apply(removeSheetRow(draftRef.current, rowId), "structure");
    },
    [apply],
  );

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

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

  const range = visibleSheetRowRange(draft.rows.length, scrollTop, viewportHeight);
  const topSpacer = range.start * SHEET_ROW_HEIGHT_PX;
  const bottomSpacer = Math.max(0, (draft.rows.length - range.end) * SHEET_ROW_HEIGHT_PX);
  const visibleRows = draft.rows.slice(range.start, range.end);

  return (
    <FocusSurface
      label="Sheet"
      measure="workspace"
      height="immersive"
      layer="work"
      onClose={close}
      closeOnEscape
    >
      <div className="junto-sheet flex h-full min-h-0 flex-col" data-testid="sheet-detail">
        <OverlayHeader
          eyebrow="sheet"
          title={title}
          status={`${String(draft.rows.length)} × ${String(draft.columns.length)}`}
          actions={
            <>
              <IconButton
                aria-label="Copy as markdown table"
                title={copied ? "Copied" : "Copy as markdown table"}
                onClick={copyMarkdown}
              >
                <Copy size={14} />
              </IconButton>
              <IconButton aria-label="Close sheet" title="Close" onClick={close}>
                <X size={14} />
              </IconButton>
            </>
          }
        />

        <div
          className="junto-sheet__grid"
          data-testid="sheet-grid"
          data-row-start={String(range.start)}
          data-row-end={String(range.end)}
          data-row-count={String(draft.rows.length)}
          ref={gridRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <table>
            <thead>
              <tr>
                <th className="junto-sheet__gutter" aria-hidden />
                {draft.columns.map((column) => (
                  <th key={column.id}>
                    <div className="junto-sheet__head">
                      <input
                        aria-label={`Column name ${column.name || column.id}`}
                        value={column.name}
                        placeholder="column"
                        onChange={(event) =>
                          apply(
                            renameSheetColumn(draft, column.id, event.target.value),
                            "typing",
                          )
                        }
                      />
                      <IconButton
                        aria-label={`Delete column ${column.name || column.id}`}
                        title="Delete column"
                        tone="danger"
                        onClick={() => apply(removeSheetColumn(draft, column.id), "structure")}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {topSpacer > 0 ? (
                <tr aria-hidden className="junto-sheet__spacer">
                  <td
                    colSpan={draft.columns.length + 1}
                    style={{ height: topSpacer, padding: 0, border: 0 }}
                  />
                </tr>
              ) : null}
              {visibleRows.map((row, offset) => {
                const index = range.start + offset;
                return (
                  <SheetRowView
                    key={row.id}
                    row={row}
                    index={index}
                    columns={draft.columns}
                    numericByColumn={numericByColumn}
                    onCell={onCell}
                    onDeleteRow={onDeleteRow}
                  />
                );
              })}
              {bottomSpacer > 0 ? (
                <tr aria-hidden className="junto-sheet__spacer">
                  <td
                    colSpan={draft.columns.length + 1}
                    style={{ height: bottomSpacer, padding: 0, border: 0 }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="junto-sheet__actions">
          <button
            type="button"
            onClick={() => apply(addSheetRow(draft), "structure")}
            disabled={atRowLimit}
            title={atRowLimit ? `A sheet holds ${String(SHEET_MAX_ROWS)} rows` : "Add a row"}
          >
            <Plus size={11} aria-hidden /> Row
          </button>
          <button
            type="button"
            onClick={() => apply(addSheetColumn(draft), "structure")}
            disabled={atColumnLimit}
            title={
              atColumnLimit
                ? `A sheet holds ${String(SHEET_MAX_COLUMNS)} columns`
                : "Add a column"
            }
          >
            <Plus size={11} aria-hidden /> Column
          </button>
          <span className="junto-sheet__note">
            Cells are plain text. Wired agents read this grid; they never write it.
          </span>
        </div>
      </div>
    </FocusSurface>
  );
}

const SheetRowView = memo(function SheetRowView({
  row,
  index,
  columns,
  numericByColumn,
  onCell,
  onDeleteRow,
}: {
  readonly row: EtherSheet["rows"][number];
  readonly index: number;
  readonly columns: EtherSheet["columns"];
  readonly numericByColumn: Readonly<Record<string, boolean>>;
  readonly onCell: (rowId: string, columnId: string, value: string) => void;
  readonly onDeleteRow: (rowId: string) => void;
}) {
  const rowStyle = { height: SHEET_ROW_HEIGHT_PX } satisfies CSSProperties;
  return (
    <tr style={rowStyle}>
      <td className="junto-sheet__gutter">
        <div className="junto-sheet__gutter-inner">
          <span>{index + 1}</span>
          <IconButton
            aria-label={`Delete row ${String(index + 1)}`}
            title="Delete row"
            tone="danger"
            onClick={() => onDeleteRow(row.id)}
          >
            <Trash2 size={11} />
          </IconButton>
        </div>
      </td>
      {columns.map((column) => (
        <td key={column.id}>
          <input
            aria-label={`${column.name || column.id} row ${String(index + 1)}`}
            value={row.cells[column.id] ?? ""}
            data-numeric={numericByColumn[column.id] ? "true" : undefined}
            onChange={(event) => onCell(row.id, column.id, event.target.value)}
          />
        </td>
      ))}
    </tr>
  );
});
