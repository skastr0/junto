import { Table } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { isNumericColumn, sheetGlance } from "@shared/sheet";
import { DIM, INK } from "../../lib/theme";
import { editText } from "../../lib/mutations";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import "./sheet.css";

/** Rows shown on the card face before it stops and says how many are left. */
const PREVIEW_ROWS = 3;
const PREVIEW_COLUMNS = 4;

export function SheetCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
}) {
  const sheet = node.ether?.sheet;
  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = firstLine || "sheet";
  const columns = (sheet?.columns ?? []).slice(0, PREVIEW_COLUMNS);
  const rows = (sheet?.rows ?? []).slice(0, PREVIEW_ROWS);
  const hiddenRows = Math.max(0, (sheet?.rows.length ?? 0) - rows.length);

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-2">
        <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
          <Table size={14} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename sheet"
              onCommit={(next) => editText(node.id, next)}
              onDone={() => onRenameDone?.()}
            />
          ) : (
            <div className="truncate text-[11px]" style={{ color: INK }}>
              {label}
            </div>
          )}
          <div className="truncate text-[9px]" style={{ color: DIM }}>
            {sheetGlance(sheet)}
          </div>
        </div>
      </div>

      {sheet && columns.length > 0 ? (
        <div className="junto-sheet-preview">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.id} className="truncate">
                    {column.name || " "}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className="truncate"
                      data-numeric={isNumericColumn(sheet, column.id) ? "true" : undefined}
                    >
                      {row.cells[column.id] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenRows > 0 ? (
            <div className="junto-sheet-preview__more">
              +{hiddenRows} more row{hiddenRows === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
