import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@shared/canvas";
import type { FlowNode } from "../../lib/convert";
import { entityReadout } from "../../lib/entity-readout";
import { editText } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { INK, DIM, SOURCE_HUE, withAlpha } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

// An entity card (project / agent) is ONE node: its name, one line of live
// stats hydrated from its connectors, and a quiet dot per connector. Never a
// wall of chips, never exploded into child nodes.
function EntityCard({ node, kind }: { readonly node: CanvasNode; readonly kind: string }) {
  const snapshots = use$(state$.snapshots);
  const name = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const { segments, dots } = entityReadout(node.ether?.bindings, snapshots);
  const line = segments.join(" · ");
  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[8px] uppercase tracking-[0.18em]" style={{ color: "#68604a" }}>{kind}</span>
          <span className="flex items-center gap-1.5">
            {dots.map(({ source, ok }, i) => (
              <span
                key={`${source}-${i}`}
                title={`${source} · ${ok ? "fresh" : "stale"}`}
                className="size-[5px] rounded-full"
                style={{
                  background: SOURCE_HUE[source] ?? DIM,
                  opacity: ok ? 1 : 0.3,
                  boxShadow: ok ? `0 0 6px ${withAlpha(SOURCE_HUE[source] ?? DIM, 0.6)}` : "none",
                }}
              />
            ))}
          </span>
        </div>
        <div className="mt-1 truncate text-[14px] font-semibold leading-snug" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }} title={name}>
          {name}
        </div>
      </div>
      <div className="line-clamp-2 text-[10px] leading-snug tabular-nums" style={{ color: DIM }} title={line}>
        {line || "no live data"}
      </div>
    </div>
  );
}

export function TextNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const text = node.type === "text" ? node.text : "";
  const editNodeId = use$(state$.editNodeId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(text);
      ref.current?.focus();
      ref.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => {
    if (editNodeId !== node.id) return;
    setEditing(true);
    state$.editNodeId.set("");
  }, [editNodeId, node.id]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) editText(node.id, draft);
  };

  const lines = text.split("\n");
  const firstIsHeading = lines[0]?.startsWith("#") ?? false;
  const head = firstIsHeading ? lines[0].replace(/^#+\s*/, "") : lines[0];
  const rest = lines.slice(1).join("\n").trim();

  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked} onEdit={() => setEditing(true)}>
      {editing ? (
        <textarea
          ref={ref}
          autoFocus
          aria-label="Edit note"
          className="nodrag nowheel h-full w-full resize-none bg-transparent text-[12px] leading-relaxed outline-none"
          style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : node.ether?.entity ? (
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditing(true);
          }}
        >
          <EntityCard node={node} kind={node.ether.entity.kind} />
        </div>
      ) : (
        <button
          type="button"
          className="nopan h-full w-full cursor-text overflow-hidden border-0 bg-transparent p-0 text-left"
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
          <div
            className={firstIsHeading ? "text-[15px] font-semibold leading-snug" : "text-[12px] leading-snug"}
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {head}
          </div>
          {rest ? (
            <div className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: DIM }}>
              {rest}
            </div>
          ) : null}
        </button>
      )}
    </NodeShell>
  );
}
