import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import type { FlowNode } from "../../lib/convert";
import { editLink } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
};

export function LinkNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const url = node.type === "link" ? node.url : "";
  const [editing, setEditing] = useState(false);
  const editNodeId = use$(state$.editNodeId);
  const [draft, setDraft] = useState(url);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(url);
    ref.current?.focus();
    ref.current?.select();
  }, [editing, url]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== url) editLink(node.id, draft.trim());
  };
  const host = hostOf(url);
  const rest = url.replace(/^https?:\/\/[^/]+/, "");

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked} onEdit={() => setEditing(true)} onOpen={() => window.open(url, "_blank")}>
      {editing ? <input ref={ref} autoFocus aria-label="Edit URL" className="nodrag nopan h-full w-full bg-transparent text-[12px] outline-none" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setEditing(false); }} /> : <button type="button" className="nopan flex h-full w-full items-start gap-2 border-0 bg-transparent p-0 text-left" onClick={(event) => { if (!selected) return; event.stopPropagation(); setEditing(true); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(true); }}>
        <Link2 size={15} className="mt-0.5 shrink-0" style={{ color: HUE.cyan }} />
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold underline decoration-dotted underline-offset-2"
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {host}
          </div>
          {rest && rest !== "/" ? (
            <div
              className="truncate text-[10px]"
              style={{ color: DIM, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            >
              {rest}
            </div>
          ) : null}
        </div>
      </button>}
    </NodeShell>
  );
}
