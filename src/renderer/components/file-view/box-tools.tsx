import { useMemo, useState, type ReactNode } from "react";
import { Crop, MessageSquarePlus, Minus, Plus, SquareDashed, X } from "lucide-react";
import type { FileSource } from "@shared/artifact";
import type { FilePath } from "@shared/files";
import type { NodeId } from "@shared/physics/schema";
import { useCanvas } from "../../lib/use-model";
import { Button, Dropdown, IconButton, Kbd } from "../ui";
import { extractTargets, extractToArtifact, type BoxShot, type ExtractTarget } from "./extract";
import { boxByArrow, KEYBOARD_BOX, zoomLabel, type ViewBox } from "./file-view-model";

/** A box drawn on a file and not yet used: on a page of a PDF, or on an image (no page). */
export type BoxDraft = { readonly page?: number; readonly box: ViewBox };

/**
 * A comment on a box, handed to the comments track (F7) with the shot it
 * may show before posting, as the page composer shows its own.
 */
export type BoxComment = BoxDraft & { readonly shot: BoxShot };

/** A comment thread's box on a file, shown wherever the file is open. */
export type FileThreadBox = { readonly id: string; readonly page?: number; readonly box: ViewBox; readonly label?: string };

/** What every viewer is told about the file it shows. */
export type FileViewProps = {
  readonly canvasName: string;
  /** The Files node, and the file's path relative to its root. */
  readonly nodeId: NodeId;
  readonly path: FilePath;
  /** The file's bytes: its `junto-file:` address (`fileUrl`). */
  readonly url: string;
  readonly boxes?: ReadonlyArray<FileThreadBox>;
  /** Comment on a drawn box. Absent: the box offers extract only. */
  readonly onComment?: (comment: BoxComment) => void;
  /** The page a PDF opens on (an extract's source page); the first when absent. */
  readonly initialPage?: number;
};

type ExtractState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string };

/**
 * The box tool, the drawn box and what it does, shared by the PDF and the
 * image viewers: they differ only in how a box becomes pixels (`shoot`).
 */
export const useBoxTools = ({
  canvasName,
  nodeId,
  path,
  onComment,
  shoot,
}: Pick<FileViewProps, "canvasName" | "nodeId" | "path" | "onComment"> & {
  readonly shoot: (draft: BoxDraft) => Promise<BoxShot>;
}) => {
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<BoxDraft | null>(null);
  const [extract, setExtract] = useState<ExtractState>({ kind: "idle" });
  const canvas = useCanvas(canvasName);
  const targets = useMemo(() => extractTargets(canvas, nodeId), [canvas, nodeId]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = targets.find((entry) => entry.id === targetId) ?? targets[0] ?? null;

  const draw = (next: BoxDraft): void => {
    setDraft(next);
    setExtract({ kind: "idle" });
  };
  const discard = (): void => setDraft(null);

  const comment = (): void => {
    if (draft === null || onComment === undefined) return;
    const taken = draft;
    void shoot(taken).then(
      (shot) => {
        onComment({ ...taken, shot });
        setDraft(null);
      },
      (error: unknown) => setExtract({ kind: "failed", line: error instanceof Error ? error.message : String(error) }),
    );
  };

  const extractBox = (): void => {
    if (draft === null || target === null || extract.kind === "pending") return;
    const taken = draft;
    const source: FileSource = {
      nodeId,
      path,
      ...(taken.page === undefined ? {} : { page: taken.page }),
      box: taken.box,
    };
    setExtract({ kind: "pending" });
    void shoot(taken)
      .then((shot) => extractToArtifact({ canvasName, target, source, shot }))
      .then(
        (outcome) => {
          if (outcome.kind === "failed") {
            setExtract({ kind: "failed", line: outcome.line });
            return;
          }
          setDraft(null);
          setExtract({
            kind: "done",
            line: outcome.kind === "created" ? `Extracted to ${outcome.target.title}.` : `Extract queued for ${outcome.target.title}.`,
          });
        },
        (error: unknown) => setExtract({ kind: "failed", line: error instanceof Error ? error.message : String(error) }),
      );
  };

  /**
   * The viewer's own keys: B toggles the box tool; with it on, Enter drops a
   * centred box on `page` (the page in view, none on an image), arrows move
   * a drawn box and Shift with an arrow resizes it; Escape drops the box and
   * then the tool. A box is never pointer-only.
   */
  const onKey = (event: React.KeyboardEvent, page?: number): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "b" || event.key === "B") {
      setDrawing((on) => !on);
      return true;
    }
    if (event.key === "Escape" && draft !== null) {
      setDraft(null);
      return true;
    }
    if (event.key === "Escape" && drawing) {
      setDrawing(false);
      return true;
    }
    if (!drawing) return false;
    // Enter on a button inside the box presses the button.
    if (event.key === "Enter" && draft === null && !(event.target instanceof HTMLButtonElement)) {
      draw(page === undefined ? { box: KEYBOARD_BOX } : { page, box: KEYBOARD_BOX });
      return true;
    }
    if (draft !== null) {
      const box = boxByArrow(draft.box, event.key, event.shiftKey);
      if (box !== undefined) {
        draw({ ...draft, box });
        return true;
      }
    }
    return false;
  };

  return {
    drawing,
    setDrawing,
    draft,
    draw,
    discard,
    comment: onComment === undefined ? undefined : comment,
    extractBox,
    extract,
    targets,
    target,
    setTargetId,
    onKey,
  };
};

export type BoxTools = ReturnType<typeof useBoxTools>;

/** The drawn box's buttons, under the box. */
export function BoxActions({ tools }: { readonly tools: BoxTools }) {
  const pending = tools.extract.kind === "pending";
  return (
    <>
      {tools.comment === undefined ? null : (
        <Button size="xs" variant="chrome" data-testid="file-box-comment" onClick={tools.comment} disabled={pending}>
          <MessageSquarePlus size={12} aria-hidden />
          Comment
        </Button>
      )}
      <Button
        size="xs"
        variant="primary"
        data-testid="file-box-extract"
        onClick={tools.extractBox}
        disabled={pending || tools.target === null}
        title={tools.target === null ? "No Artifacts node is in reach of this Files node" : `Make an image artifact in ${tools.target.title}`}
      >
        <Crop size={12} aria-hidden />
        {pending ? "Extracting" : "Extract as artifact"}
      </Button>
      <IconButton size="sm" aria-label="Discard the box" title="Discard the box (Esc)" onClick={tools.discard} disabled={pending}>
        <X size={12} aria-hidden />
      </IconButton>
    </>
  );
}

/**
 * The viewer's toolbar: zoom, the box tool, where an extract lands, and what
 * the last extract did. `pages` is the PDF's page control, absent on an image.
 */
export function ViewerToolbar({
  zoom,
  fitted,
  onZoomIn,
  onZoomOut,
  onFit,
  onActual,
  tools,
  pages,
  announce,
}: {
  /** What a screen reader hears when the view moves: the zoom, and the page on a PDF. */
  readonly announce: string;
  readonly zoom: number;
  readonly fitted: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly onActual: () => void;
  readonly tools: BoxTools;
  readonly pages?: ReactNode;
}) {
  const options = tools.targets.map((entry: ExtractTarget) => ({ value: entry.id, label: entry.title }));
  return (
    <div className="file-view__bar" role="toolbar" aria-label="Viewer">
      <span className="sr-only" aria-live="polite" data-testid="file-view-announce">
        {announce}
      </span>
      <div className="file-view__group">
        <IconButton size="sm" aria-label="Zoom out" title="Zoom out (-)" onClick={onZoomOut}>
          <Minus size={13} aria-hidden />
        </IconButton>
        <button type="button" className="file-view__zoom" data-testid="file-view-zoom" title="Actual size (0)" onClick={onActual}>
          {zoomLabel(zoom)}
        </button>
        <IconButton size="sm" aria-label="Zoom in" title="Zoom in (+)" onClick={onZoomIn}>
          <Plus size={13} aria-hidden />
        </IconButton>
        <Button size="xs" variant="subtle" aria-pressed={fitted} data-testid="file-view-fit" onClick={onFit}>
          Fit
        </Button>
      </div>
      {pages === undefined ? null : <div className="file-view__group">{pages}</div>}
      <div className="file-view__group">
        <Button
          size="xs"
          variant="chrome"
          aria-pressed={tools.drawing}
          data-testid="file-view-box-tool"
          title="Draw a box to comment on it or extract it. From the keyboard: Enter drops one, arrows move it, Shift and arrows resize it"
          onClick={() => tools.setDrawing((on) => !on)}
        >
          <SquareDashed size={12} aria-hidden />
          {tools.drawing ? "Drawing a box" : "Box"}
          <Kbd>B</Kbd>
        </Button>
        {options.length > 1 ? (
          <Dropdown
            value={tools.target?.id ?? ""}
            options={options}
            onChange={tools.setTargetId}
            aria-label="Artifacts node an extract goes to"
            title="Where Extract as artifact puts the image"
            align="end"
          />
        ) : null}
      </div>
      {tools.extract.kind === "done" || tools.extract.kind === "failed" ? (
        <p
          className="file-view__said"
          data-tone={tools.extract.kind === "failed" ? "refused" : undefined}
          role={tools.extract.kind === "failed" ? "alert" : "status"}
          data-testid="file-view-said"
        >
          {tools.extract.line}
        </p>
      ) : null}
    </div>
  );
}
