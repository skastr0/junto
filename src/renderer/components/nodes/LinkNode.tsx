/** A page work surface, or a retired link card. */
import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import { formatNodeRef } from "@shared/node-ref";
import { PageCard } from "../browser/PageCard";
import { PageToolbarActions } from "../browser/PageToolbarActions";
import type { FlowNode } from "../../lib/convert";
import { openDockBrowser } from "../../lib/dock-state";
import { browser$ } from "../../lib/browser-state";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { useNodeFieldOf, useNodeValue, useNodeOf } from "../../lib/use-model";
import { DIM, HUE, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";
import { BROWSER_ENABLED } from "@shared/features";

export function LinkNode({ id, data, selected }: NodeProps<FlowNode>) {
  const canvasName = use$(state$.canvasName);
  // A page or a plain link, its address and how its session is kept, from the
  // node store.
  const kind = useNodeValue(canvasName, id, (node) => node?.kind);
  const url = useNodeValue(canvasName, id, (node) =>
    node?.kind === "page" || node?.kind === "link" ? node.url : "",
  );
  const profile = useNodeFieldOf(canvasName, id, "page", (page) => page.profile);
  const onRemove = useNodeFieldOf(canvasName, id, "page", (page) => page.onRemove);
  const node = useNodeOf(canvasName, id, "page");
  const isPage = BROWSER_ENABLED && kind === "page";
  const isEditTarget = use$(() => state$.editNodeId.get() === id);
  const pageRef = useMemo(() => {
    if (!isPage) return undefined;
    try {
      return formatNodeRef({ canvasName, nodeId: id });
    } catch {
      return undefined;
    }
  }, [canvasName, isPage, id]);
  const session = use$(browser$.sessionByRef[pageRef ?? ""]);

  // No inline path edit surface remains for link cards — clear edit targeting.
  useEffect(() => {
    if (!isEditTarget) return;
    state$.editNodeId.set("");
  }, [isEditTarget]);

  if (isPage) {
    const open = () => {
      if (!pageRef || profile === undefined) return;
      void openDockBrowser(pageRef, {
        nodeId: id,
        browser: { profile, onDelete: onRemove ?? "kill-session" },
        url,
        title: session?.title ?? hostOf(url),
      });
    };
    return (
      <NodeShell
        canvas={canvasName}
        id={id}
        selected={selected}
        blocked={data.blocked}
        toolbarExtras={node ? <PageToolbarActions node={node} /> : undefined}
      >
        <div
          className="nopan h-full w-full"
          onDoubleClick={(event) => {
            if (event.shiftKey) return;
            event.preventDefault();
            event.stopPropagation();
            open();
          }}
        >
          {node ? <PageCard node={node} /> : null}
        </div>
      </NodeShell>
    );
  }

  const host = hostOf(url) || "retired link";
  return (
    <NodeShell canvas={canvasName} id={id} selected={selected} blocked={data.blocked}>
      <div className="flex h-full w-full items-start gap-2 opacity-55">
        <Link2 size={15} className="mt-0.5 shrink-0" style={{ color: HUE.cyan }} />
        <div className="min-w-0">
          <div
            className="truncate font-mono text-[12px] font-semibold"
            style={{ color: INK }}
            title={url}
          >
            {host}
          </div>
          <div className="truncate font-mono text-[10px]" style={{ color: DIM }}>
            retired - delete to remove
          </div>
        </div>
      </div>
    </NodeShell>
  );
}
