import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { Globe, Link2 } from "lucide-react";
import { PageCard } from "../browser/PageCard";
import type { FlowNode } from "../../lib/convert";
import { editLink, promoteLinkToPage } from "../../lib/mutations";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { DIM, HUE, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

export function LinkNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const url = node.type === "link" ? node.url : "";
  // A page work surface is a link node upgraded via promoteLinkToPage (or
  // created through addPage) — kind "page" + a bound ether.browser. Plain
  // links carry neither and keep window.open external behavior exactly as
  // before this branch existed.
  const isPage = node.ether?.entity?.kind === "page" && Boolean(node.ether?.browser);
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
    <NodeShell node={node} selected={selected} blocked={data.blocked} onEdit={() => setEditing(true)} onOpen={isPage ? undefined : () => window.open(url, "_blank")}>
      {editing ? (
        <input ref={ref} autoFocus aria-label="Edit URL" className="nodrag nopan h-full w-full bg-transparent text-[12px] outline-none" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setEditing(false); }} />
      ) : isPage ? (
        <PageCard node={node} />
      ) : (
        <div className="flex h-full w-full flex-col justify-between overflow-hidden">
          <button type="button" className="nopan flex w-full items-start gap-2 border-0 bg-transparent p-0 text-left" onClick={(event) => { if (!selected) return; event.stopPropagation(); setEditing(true); }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(true); }}>
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
          </button>
          <button
            type="button"
            className="nodrag nopan mt-1 flex w-fit items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
            title="Promote to a bound browser page work surface"
            onClick={(event) => {
              event.stopPropagation();
              promoteLinkToPage(node.id, "personal");
            }}
          >
            <Globe size={10} />
            page
          </button>
        </div>
      )}
    </NodeShell>
  );
}
