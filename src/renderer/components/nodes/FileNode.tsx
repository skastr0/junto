import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { FileText } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { editFile } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { DIM, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

export function FileNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const path = node.type === "file" ? node.file : "";
  const subpath = node.type === "file" ? node.subpath ?? "" : "";
  const [editing, setEditing] = useState(false);
  const editNodeId = use$(state$.editNodeId);
  const [draft, setDraft] = useState(path);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(path);
    ref.current?.focus();
    ref.current?.select();
  }, [editing, path]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== path) editFile(node.id, draft.trim());
  };
  const segments = path.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? path;
  const dir = segments.slice(0, -1).join("/");

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked} onEdit={() => setEditing(true)}>
      {editing ? <input ref={ref} autoFocus aria-label="Edit file path" className="nodrag nopan h-full w-full bg-transparent text-[12px] outline-none" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setEditing(false); }} /> : <button type="button" className="nopan flex h-full w-full items-start gap-2 border-0 bg-transparent p-0 text-left" onClick={(event) => { if (!selected) return; event.stopPropagation(); setEditing(true); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(true); }}>
        <FileText size={15} className="mt-0.5 shrink-0" style={{ color: DIM }} />
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold"
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {base}
          </div>
          {dir ? (
            <div
              className="truncate text-[10px]"
              style={{ color: DIM, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            >
              {dir}/
            </div>
          ) : null}
          {subpath ? <div className="truncate text-[10px]" style={{ color: DIM, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{subpath}</div> : null}
        </div>
      </button>}
      </NodeShell>
  );
}
