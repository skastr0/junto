import type { CaptureRow } from "./capture-list";
import { FilePreview, LinkPreview } from "../artifacts/ArtifactPreview";
import { LiveMarkdownField } from "../artifacts/lazy-editors";
import { ArtifactPadEditor } from "../artifacts/ArtifactPadEditor";
import type { BodyOf } from "@shared/artifact";

type SheetGrid = BodyOf<"sheet">["grid"];

/**
 * The focused row, large, as its type reads (0.11, 11 Q1): a document
 * rendered, a pad drawn, a sheet as a table, a link or a file as its preview.
 * Read only: Enter is what edits it, so nothing here takes a write.
 */

const NO_PATCH = async (): Promise<string | null> => null;

/** A sheet as a table: its columns in order, the first rows, no editing. */
function SheetPreview({ grid, title }: { readonly grid: SheetGrid; readonly title: string }) {
  const rows = grid.rows.slice(0, 8);
  const cells = (row: SheetGrid["rows"][number]): ReadonlyArray<string> =>
    Object.keys(row.cells).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((key) => row.cells[key] ?? "");
  return (
    <table className="quick-capture__sheet" aria-label={title}>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {cells(row).map((value, column) => (
              <td key={column}>{value}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CapturePreview({ row, canvasName }: { readonly row: CaptureRow; readonly canvasName: string }) {
  const body = row.head.body;
  if (body === null) return <p className="quick-capture__preview-detail">Reading it.</p>;
  switch (body.type) {
    case "document":
      return (
        <div className="quick-capture__preview-doc">
          <LiveMarkdownField value={body.markdown} label={row.title} surfaceLabel={`${row.title}, document`} readOnly />
        </div>
      );
    case "sheet":
      return <SheetPreview grid={body.grid} title={row.title} />;
    case "pad":
      return (
        <div className="quick-capture__preview-pad">
          <ArtifactPadEditor canvasName={canvasName} pad={body.pad} readOnly onPatch={NO_PATCH} />
        </div>
      );
    case "link":
      return <LinkPreview body={body} />;
    case "file":
      return <FilePreview body={body} />;
  }
}
