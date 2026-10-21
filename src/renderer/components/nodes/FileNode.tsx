/**
 * Image geography card: a file node whose path is a content-store
 * image URL. Plain workspace-path file furniture is retired; legacy docs still
 * decode but render as a delete-only stub (no authoring path).
 */
import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { FileText, X } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { imageContentRefFromFile } from "../../lib/image-content";
import { state$ } from "../../lib/state";
import { useNodeFieldOf } from "../../lib/use-model";
import { ContentMedia } from "../work/ContentMedia";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, IconButton } from "../ui";
import { NodeShell } from "./NodeShell";
import { SpineCard } from "./SpineCard";

/** The folders a path sits in, the nearest last: what the leaf line names, its start giving way. */
const pathTail = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : path;
};

export function FileNode({ id, data, selected }: NodeProps<FlowNode>) {
  const canvasName = use$(state$.canvasName);
  const path = useNodeFieldOf(canvasName, id, "file", (file) => file.path) ?? "";
  const imageRef = imageContentRefFromFile(path);
  const [expanded, setExpanded] = useState(false);
  const isEditTarget = use$(() => state$.editNodeId.get() === id);

  useEffect(() => {
    if (!isEditTarget) return;
    if (imageRef) setExpanded(true);
    state$.editNodeId.set("");
  }, [isEditTarget, id, imageRef]);

  if (imageRef) {
    const title = imageRef.displayName ?? imageRef.mediaType;
    return (
      <>
        <NodeShell
          canvas={canvasName}
          id={id}
          selected={selected}
          blocked={data.blocked}
        >
          <button
            type="button"
            className="file-node-image nodrag nopan"
            aria-label={`Image ${title}`}
            onClick={(event) => {
              if (!selected) return;
              event.stopPropagation();
              setExpanded(true);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            <ContentMedia
              contentRef={imageRef}
              alt={title}
              bare
              controls={false}
              className="file-node-image__media"
            />
          </button>
        </NodeShell>
        {expanded ? (
          <FocusSurface
            measure="workspace"
            height="resizable"
            label="Image"
            onClose={() => setExpanded(false)}
          >
            <div className="file-node-image-focus nowheel">
              <div className="file-node-image-focus__chrome">
                <Eyebrow tone="faint" size="xs">
                  image
                </Eyebrow>
                <div className="file-node-image-focus__title" title={title}>
                  {title}
                </div>
                <IconButton
                  size="sm"
                  aria-label="Close image"
                  title="Close"
                  onClick={() => setExpanded(false)}
                >
                  <X size={13} />
                </IconButton>
              </div>
              <div className="file-node-image-focus__body">
                <ContentMedia
                  contentRef={imageRef}
                  alt={title}
                  bare
                  controls={false}
                  className="file-node-image-focus__media"
                />
              </div>
              <div className="file-node-image-focus__hint">
                <Button size="xs" variant="chrome" onClick={() => setExpanded(false)}>
                  done
                </Button>
              </div>
            </div>
          </FocusSurface>
        ) : null}
      </>
    );
  }

  // Legacy plain path furniture — decode-admits-history only.
  const base = path.split("/").filter(Boolean).pop() ?? (path || "retired file");
  return (
    <NodeShell canvas={canvasName} id={id} selected={selected} blocked={data.blocked} look="spine">
      <div title={path}>
        <SpineCard glyph={<FileText />} hue="dim" name={base} status="retired" dashed body={{ kind: "leaf", line: pathTail(path), tail: true }} />
      </div>
    </NodeShell>
  );
}
