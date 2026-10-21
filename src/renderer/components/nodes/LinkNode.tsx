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
import { NodeShell } from "./NodeShell";
import { SpineCard } from "./SpineCard";
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
        look="spine"
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
    <NodeShell canvas={canvasName} id={id} selected={selected} blocked={data.blocked} look="spine">
      <div title={url}>
        <SpineCard glyph={<Link2 />} hue="cyan" name={host} status="retired" dashed body={{ kind: "leaf", line: url || host }} />
      </div>
    </NodeShell>
  );
}
