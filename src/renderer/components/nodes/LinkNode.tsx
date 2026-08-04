/**
 * Page work surface — JSON Canvas `link` + entity.kind page + ether.browser.
 * Plain link furniture is retired; legacy url-only cards still decode but
 * render as a delete-only stub (no promote path).
 */
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
import { DIM, HUE, INK } from "../../lib/theme";
import { NodeShell } from "./NodeShell";

const isPageSurface = (node: FlowNode["data"]["node"]): boolean =>
  node.type === "link" &&
  node.ether?.entity?.kind === "page" &&
  Boolean(node.ether?.browser);

export function LinkNode({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node;
  const url = node.type === "link" ? node.url : "";
  const isPage = isPageSurface(node);
  const isEditTarget = use$(() => state$.editNodeId.get() === node.id);
  const canvasName = use$(state$.canvasName);
  const pageRef = useMemo(() => {
    if (!isPage) return undefined;
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  }, [canvasName, isPage, node.id]);
  const session = use$(browser$.sessionByRef[pageRef ?? ""]);

  // No inline path edit surface remains for link cards — clear edit targeting.
  useEffect(() => {
    if (!isEditTarget) return;
    state$.editNodeId.set("");
  }, [isEditTarget]);

  if (isPage) {
    const browser = node.ether?.browser;
    const open = () => {
      if (!pageRef || !browser) return;
      void openDockBrowser(pageRef, {
        nodeId: node.id,
        browser,
        url,
        title: session?.title ?? hostOf(url),
      });
    };
    return (
      <NodeShell
        node={node}
        selected={selected}
        blocked={data.blocked}
        toolbarExtras={<PageToolbarActions node={node} />}
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
          <PageCard node={node} />
        </div>
      </NodeShell>
    );
  }

  const host = hostOf(url) || "retired link";
  return (
    <NodeShell node={node} selected={selected} blocked={data.blocked}>
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
            retired · delete to remove
          </div>
        </div>
      </div>
    </NodeShell>
  );
}
