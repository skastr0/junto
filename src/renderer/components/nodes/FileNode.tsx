import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { FileText, X } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { imageContentRefFromFile } from "../../lib/image-content";
import { editFile } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { DIM, INK } from "../../lib/theme";
import { ContentMedia } from "../work/ContentMedia";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, IconButton } from "../ui";
import { NodeShell } from "./NodeShell";

export function FileNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const path = node.type === "file" ? node.file : "";
  const subpath = node.type === "file" ? node.subpath ?? "" : "";
  const imageRef = imageContentRefFromFile(path);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);
  const [draft, setDraft] = useState(path);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(path);
    ref.current?.focus();
    ref.current?.select();
  }, [editing, path]);

  useEffect(() => {
    if (!isEditTarget) return;
    if (imageRef) {
      setExpanded(true);
      state$.editNodeId.set("");
      return;
    }
    setEditing(true);
    state$.editNodeId.set("");
  }, [isEditTarget, node.id, imageRef]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== path) editFile(node.id, draft.trim());
  };
  const segments = path.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? path;
  const dir = segments.slice(0, -1).join("/");
  const title =
    imageRef?.displayName ??
    (imageRef ? imageRef.mediaType : base);

  if (imageRef) {
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
                  title="close"
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

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked}>
      {editing ? (
        <input
          ref={ref}
          autoFocus
          aria-label="Edit file path"
          className="nodrag nopan h-full w-full bg-transparent font-mono text-[12px] outline-none"
          style={{ color: INK }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="nopan flex h-full w-full items-start gap-2 border-0 bg-transparent p-0 text-left"
          onClick={(event) => {
            if (!selected) return;
            event.stopPropagation();
            setEditing(true);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditing(true);
          }}
        >
          <FileText size={15} className="mt-0.5 shrink-0" style={{ color: DIM }} />
          <div className="min-w-0">
            <div
              className="truncate font-mono text-[12px] font-semibold"
              style={{ color: INK }}
            >
              {base}
            </div>
            {dir ? (
              <div
                className="truncate font-mono text-[10px]"
                style={{ color: DIM }}
              >
                {dir}/
              </div>
            ) : null}
            {subpath ? (
              <div className="truncate font-mono text-[10px]" style={{ color: DIM }}>
                {subpath}
              </div>
            ) : null}
          </div>
        </button>
      )}
    </NodeShell>
  );
}
