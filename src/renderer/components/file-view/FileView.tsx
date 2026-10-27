import { lazy, Suspense, useState } from "react";
import { FileQuestion, FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import { fileUrl } from "@shared/file-url";
import type { FilesError, JuntoFilesApi } from "@shared/files";
import { Button, PaneEmpty } from "../ui";
import type { FileViewProps } from "./box-tools";
import { fileNameOf, fileViewKindOf } from "./file-view-model";
import "./file-view.css";

// The PDF viewer carries pdf.js behind a dynamic import of its own; the
// viewer itself is small, but nothing of it loads until a PDF opens.
const PdfViewer = lazy(() => import("./PdfViewer").then((m) => ({ default: m.PdfViewer })));
const ImageViewer = lazy(() => import("./ImageViewer").then((m) => ({ default: m.ImageViewer })));

type FilesPort = Pick<JuntoFilesApi["files"], "openInDefaultApp" | "revealInFinder">;

const filesPort = (): FilesPort | undefined => (window.junto as Partial<JuntoFilesApi> | undefined)?.files;

const ERROR_LINE: Partial<Record<FilesError, string>> = {
  "not-found": "The file is not there any more.",
  "root-missing": "The node's folder is not there any more.",
  denied: "macOS refused it permission.",
  elsewhere: "This Files node lives on another machine.",
};

/**
 * A file that is not text, in the main pane (F6): a PDF or an image previews
 * here; anything else offers its default app and Finder. `version` is the
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
      {kind === "pdf" ? <PdfViewer key={url} {...props} url={url} /> : <ImageViewer key={url} {...props} url={url} />}
    </Suspense>
  );
}

function OtherFile({ canvasName, nodeId, path }: Omit<FileViewProps, "url">) {
  const [said, setSaid] = useState<string | null>(null);
  const port = filesPort();
  const run = (call: FilesPort[keyof FilesPort]): void => {
    setSaid(null);
    void call({ canvas: canvasName, node: nodeId }, path).then(
      (result) => setSaid(result.ok ? null : (ERROR_LINE[result.error] ?? "That did not work.")),
      () => setSaid("That did not work."),
    );
  };
  return (
    <div className="file-view file-view--other" data-testid="file-view-other">
      <PaneEmpty
        glyph={<FileQuestion size={20} />}
        title={fileNameOf(path)}
        hint="Junto previews PDFs and images. Open this one in its own app."
        action={
          <div className="file-view__other-actions">
            <Button size="sm" variant="primary" disabled={port === undefined} onClick={() => port && run(port.openInDefaultApp)}>
              <SquareArrowOutUpRight size={13} aria-hidden />
              Open in default app
            </Button>
            <Button size="sm" variant="subtle" disabled={port === undefined} onClick={() => port && run(port.revealInFinder)}>
              <FolderOpen size={13} aria-hidden />
              Reveal in Finder
            </Button>
          </div>
        }
      />
      {said === null ? null : (
        <p className="file-view__said" data-tone="refused" role="alert">
          {said}
        </p>
      )}
    </div>
  );
}
