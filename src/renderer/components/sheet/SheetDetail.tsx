import { useEffect, useMemo, useRef, useState } from "react";
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
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  type EtherSheet,
} from "@shared/sheet";
import { FocusSurface } from "../FocusSurface";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { setNodeSheet } from "../../lib/mutations";
import "./sheet.css";

/**
 * The sheet editor: a grid of text inputs, one row of column headers, and the
 * two buttons that grow it. Every keystroke commits to the canvas document —
 * there is no save button because there is no second copy of the data.
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
  const sheet = useMemo<EtherSheet>(() => stored ?? emptySheet(), [stored]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const write = (next: EtherSheet): void => {
    setNodeSheet(node.id, next);
  };

  const copyMarkdown = (): void => {
    void navigator.clipboard?.writeText(sheetToMarkdown(sheet)).then(() => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1_200);
    });
  };

  const atColumnLimit = sheet.columns.length >= SHEET_MAX_COLUMNS;
  const atRowLimit = sheet.rows.length >= SHEET_MAX_ROWS;

  return (
    <FocusSurface
      label="Sheet"
      measure="workspace"
      height="immersive"
      layer="work"
      onClose={onClose}
      closeOnEscape
    >
      <div className="vellum-sheet flex h-full min-h-0 flex-col" data-testid="sheet-detail">
        <OverlayHeader
          eyebrow="sheet"
          title={title}
          status={`${String(sheet.rows.length)} × ${String(sheet.columns.length)}`}
          actions={
            <>
              <IconButton
                aria-label="Copy as markdown table"
                title={copied ? "Copied" : "Copy as markdown table"}
                onClick={copyMarkdown}
              >
                <Copy size={14} />
              </IconButton>
              <IconButton aria-label="Close sheet" title="Close" onClick={onClose}>
                <X size={14} />
              </IconButton>
            </>
          }
        />

        <div className="vellum-sheet__grid" data-testid="sheet-grid">
          <table>
            <thead>
              <tr>
                <th className="vellum-sheet__gutter" aria-hidden />
                {sheet.columns.map((column) => (
                  <th key={column.id}>
                    <div className="vellum-sheet__head">
                      <input
                        aria-label={`Column name ${column.name || column.id}`}
                        value={column.name}
                        placeholder="column"
                        onChange={(event) =>
                          write(renameSheetColumn(sheet, column.id, event.target.value))
                        }
                      />
                      <IconButton
                        aria-label={`Delete column ${column.name || column.id}`}
                        title="Delete column"
                        tone="danger"
                        onClick={() => write(removeSheetColumn(sheet, column.id))}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, index) => (
                <tr key={row.id}>
                  <td className="vellum-sheet__gutter">
                    <span>{index + 1}</span>
                    <IconButton
                      aria-label={`Delete row ${String(index + 1)}`}
                      title="Delete row"
                      tone="danger"
                      onClick={() => write(removeSheetRow(sheet, row.id))}
                    >
                      <Trash2 size={11} />
                    </IconButton>
                  </td>
                  {sheet.columns.map((column) => (
                    <td key={column.id}>
                      <input
                        aria-label={`${column.name || column.id} row ${String(index + 1)}`}
                        value={row.cells[column.id] ?? ""}
                        data-numeric={isNumericColumn(sheet, column.id) ? "true" : undefined}
                        onChange={(event) =>
                          write(setSheetCell(sheet, row.id, column.id, event.target.value))
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="vellum-sheet__actions">
          <button
            type="button"
            onClick={() => write(addSheetRow(sheet))}
            disabled={atRowLimit}
            title={atRowLimit ? `A sheet holds ${String(SHEET_MAX_ROWS)} rows` : "Add a row"}
          >
            <Plus size={11} aria-hidden /> Row
          </button>
          <button
            type="button"
            onClick={() => write(addSheetColumn(sheet))}
            disabled={atColumnLimit}
            title={
              atColumnLimit
                ? `A sheet holds ${String(SHEET_MAX_COLUMNS)} columns`
                : "Add a column"
            }
          >
            <Plus size={11} aria-hidden /> Column
          </button>
          <span className="vellum-sheet__note">
            Cells are plain text. Wired agents read this grid; they never write it.
          </span>
        </div>
      </div>
    </FocusSurface>
  );
}
