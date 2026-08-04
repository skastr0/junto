/**
 * Image geography card — JSON Canvas `file` whose path is a content-store
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
import { DIM, INK } from "../../lib/theme";
import { ContentMedia } from "../work/ContentMedia";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, IconButton } from "../ui";
import { NodeShell } from "./NodeShell";

export function FileNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const path = node.type === "file" ? node.file : "";
  const imageRef = imageContentRefFromFile(path);
  const [expanded, setExpanded] = useState(false);
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);

  useEffect(() => {
    if (!isEditTarget) return;
    if (imageRef) setExpanded(true);
    state$.editNodeId.set("");
  }, [isEditTarget, node.id, imageRef]);

  if (imageRef) {
    const title = imageRef.displayName ?? imageRef.mediaType;
    return (
      <>
        <NodeShell
          node={node}
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
            layer="detail"
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
    <NodeShell node={node} selected={selected} blocked={data.blocked}>
      <div className="flex h-full w-full items-start gap-2 opacity-55">
        <FileText size={15} className="mt-0.5 shrink-0" style={{ color: DIM }} />
        <div className="min-w-0">
          <div
            className="truncate font-mono text-[12px] font-semibold"
            style={{ color: INK }}
            title={path}
          >
            {base}
          </div>
          <div className="truncate font-mono text-[10px]" style={{ color: DIM }}>
            retired - delete to remove
          </div>
        </div>
      </div>
    </NodeShell>
  );
}
