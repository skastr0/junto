import { use$ } from "@legendapp/state/react";
import { parseFilePath } from "@shared/files";
import { asNodeId } from "@shared/physics/schema";
import { lazySurface } from "../../lib/lazy-surface";
import { state$ } from "../../lib/state";
// The modal's styles stay with the window's, in the order FilesNode takes them.
import "./file-comments.css";
import "./files-drop.css";
import "../file-view/file-view.css";
import "../ui/file-tree.css";
import "./files.css";

// The tree and the editors stay out of the window's first load.
const FilesNode = lazySurface(
  () => import("./FilesNode").then((m) => m.FilesNode),
  () => null,
);

/** The Files node's modal for the canvas, as `ArtifactsDetail` is the Artifacts node's. */
export function FilesDetail({
  nodeId,
  initialItemId,
  initialPage,
  openKey,
  onClose,
}: {
  readonly nodeId: string;
  /** Open on this file: a path relative to the node's root. */
  readonly initialItemId?: string;
  /** With a PDF in `initialItemId`, the page it opens on. */
  readonly initialPage?: number;
  /** Which open this is: a new one lands on `initialItemId` and its page again. */
  readonly openKey?: number;
  readonly onClose: () => void;
}) {
  const canvasName = use$(state$.canvasName) || "";
  const initialPath = initialItemId === undefined ? undefined : parseFilePath(initialItemId);
  return (
    <FilesNode
      canvasName={canvasName}
      nodeId={asNodeId(nodeId)}
      {...(initialPath === undefined || initialPath === "" ? {} : { initialPath })}
      {...(initialPage === undefined ? {} : { initialPage })}
      {...(openKey === undefined ? {} : { openKey })}
      onClose={onClose}
    />
  );
}
