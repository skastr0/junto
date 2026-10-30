import { lazy, Suspense, useState } from "react";
import { FileQuestion, FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import { fileUrl } from "@shared/file-url";
import { filesErrorLine, filesSource } from "../../lib/files-source";
import { onThisMachine } from "../../lib/machines";
import { useNode } from "../../lib/use-model";
import { Button, PaneEmpty } from "../ui";
import type { FileViewProps } from "./box-tools";
import { fileNameOf, fileViewKindOf } from "./file-view-model";
import "./file-view.css";

// The PDF viewer carries pdf.js behind a dynamic import of its own; the
// viewer itself is small, but nothing of it loads until a PDF opens.
const PdfViewer = lazy(() => import("./PdfViewer").then((m) => ({ default: m.PdfViewer })));
const ImageViewer = lazy(() => import("./ImageViewer").then((m) => ({ default: m.ImageViewer })));

/** Main opens nothing that would run; a refused open says so, as the Files modal does. */
const RUNS_LINE = "Junto does not open programs or scripts. Reveal it in Finder instead.";

/**
 * A file that is not text, in the main pane (F6): a PDF or an image previews
 * here; anything else offers its default app and Finder, on this machine's
 * node only: they act on the screen showing them. `version` is the
 * file's stamp, so a write elsewhere reloads the bytes.
 */
export function FileView({
  version,
  ...props
}: Omit<FileViewProps, "url"> & {
  readonly version?: number;
}) {
  const url = fileUrl(props.nodeId, props.path, version);
  const kind = fileViewKindOf(props.path);
  if (kind === "other") return <OtherFile {...props} />;
  return (
    <Suspense fallback={<p className="file-view__empty">Opening {fileNameOf(props.path)}</p>}>
      {/* Keyed by the file, not its address: a change on disk reloads the bytes and keeps the zoom and the box. */}
      {kind === "pdf" ? (
        <PdfViewer key={`${props.nodeId}/${props.path}`} {...props} url={url} />
      ) : (
        <ImageViewer key={`${props.nodeId}/${props.path}`} {...props} url={url} />
      )}
    </Suspense>
  );
}

function OtherFile({ canvasName, nodeId, path }: Omit<FileViewProps, "url">) {
  const [said, setSaid] = useState<string | null>(null);
  const node = useNode(canvasName, nodeId);
  const here = node?.kind !== "files" || onThisMachine(node.host);
  const run = (call: "openInDefaultApp" | "revealInFinder"): void => {
    setSaid(null);
    const files = filesSource();
    void files[call]({ canvas: canvasName, node: nodeId }, path).then(
      (result) => setSaid(result.ok ? null : call === "openInDefaultApp" && result.error === "denied" ? RUNS_LINE : filesErrorLine(result.error)),
      () => setSaid(filesErrorLine("failed")),
    );
  };
  const elsewhere = (
    <div className="file-view__other-actions">
      <Button size="sm" variant="primary" onClick={() => run("openInDefaultApp")}>
        <SquareArrowOutUpRight size={13} aria-hidden />
        Open in default app
      </Button>
      <Button size="sm" variant="chrome" onClick={() => run("revealInFinder")}>
        <FolderOpen size={13} aria-hidden />
        Reveal in Finder
      </Button>
    </div>
  );
  return (
    <div className="file-view file-view--other" data-testid="file-view-other">
      {/* Its default app and Finder are this screen's: another machine's file offers neither. */}
      <PaneEmpty
        glyph={<FileQuestion size={20} />}
        title={fileNameOf(path)}
        hint={here ? "Junto previews PDFs and images. Open this one in its own app." : "Junto previews PDFs and images. Open this one on its own machine."}
        {...(here ? { action: elsewhere } : {})}
      />
      {said === null ? null : (
        <p className="file-view__said" data-tone="refused" role="alert">
          {said}
        </p>
      )}
    </div>
  );
}
