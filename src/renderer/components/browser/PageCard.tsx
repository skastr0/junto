import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import { Globe } from "lucide-react";
import { browserActivity } from "../../lib/activity";
import {
  refreshBrowserSession,
  subscribeBrowserSessionEvents,
  browser$,
} from "../../lib/browser-state";
import { dock$ } from "../../lib/dock-state";
import { hostOf, nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { HUE, INK } from "../../lib/theme";
import { resolveTerminalBinding } from "@shared/terminal";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";

/**
 * Actors with a directed edge into this page that can carry browser.automate.
 * Empty/undefined edge ports = full target offer (includes browser.automate).
 */
const automatorCandidates = (
  doc: { readonly nodes: ReadonlyArray<CanvasNode>; readonly edges: ReadonlyArray<{ readonly fromNode: string; readonly toNode: string; readonly ether?: { readonly ports?: ReadonlyArray<string> } }> },
  pageId: string,
): ReadonlyArray<CanvasNode> => {
  const out: CanvasNode[] = [];
  for (const edge of doc.edges) {
    if (edge.toNode !== pageId) continue;
    const ports = edge.ether?.ports;
    if (ports && ports.length > 0 && !ports.includes("browser.automate")) continue;
    const from = doc.nodes.find((n) => n.id === edge.fromNode);
    if (from?.ether?.entity?.kind !== "agent") continue;
    out.push(from);
  }
  return out;
};

/**
 * Page card — identity + ActivityMark for session/automation.
 * Open via double-click / RTS. No action buttons on the card.
 */
export function PageCard({ node }: { readonly node: CanvasNode }) {
  const browser = node.ether?.browser;
  const url = node.type === "link" ? node.url : "";
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  const pageRef = useMemo(() => {
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  }, [canvasName, node.id]);
  const session = use$(browser$.sessionByRef[pageRef ?? ""]);
  const stopError = use$(dock$.stopErrorByRef[pageRef ?? ""]);
  const docked = use$(() => {
    if (!pageRef) return false;
    return dock$.registry.surfaces.get().some((s) => s.kind === "browser" && s.id === pageRef);
  });
  const attaching = docked && !session?.attached;

  const automators = useMemo(
    () => automatorCandidates(doc, node.id),
    [doc, node.id],
  );

  // Subscribe seat leaves for linked agents — working seat ≈ live automate pressure.
  const automatingNames = use$(() => {
    const names: string[] = [];
    for (const agent of automators) {
      const binding = resolveTerminalBinding(agent);
      const bindingId =
        binding?.kind === "native" ? binding.bindingId : undefined;
      if (!bindingId) continue;
      const seat = agentSeat$.byBindingId[bindingId].get();
      if (seat?.state === "working" || seat?.state === "attention") {
        names.push(nodeTitle(agent));
      }
    }
    return names;
  });

  useEffect(() => {
    subscribeBrowserSessionEvents();
  }, []);

  useEffect(() => {
    if (!browser || !pageRef) return;
    void refreshBrowserSession(pageRef);
  }, [browser, pageRef]);

  if (!browser || !pageRef) {
    return <div className="text-xs text-faint">page unbound</div>;
  }

  const state = session?.state ?? "idle";
  const warm =
    state === "loading" ||
    state === "ready" ||
    state === "failed" ||
    state === "detached";
  const pageTitle = session?.title;
  const host = hostOf(url);
  const automating = automatingNames.length > 0;
  const activity = browserActivity({
    state,
    attaching,
    automating,
  });
  const displayTitle = warm && pageTitle ? pageTitle : host;
  const err = stopError ?? (state === "failed" ? session?.lastError : undefined);
  const subtitle = err
    ? err
    : automating
      ? automatingNames.length === 1
        ? automatingNames[0]
        : `${automatingNames.length} agents`
      : undefined;

  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <ExecutionCardHeader
        decal={
          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
            <Globe size={15} />
          </div>
        }
        title={
          <div
            className="truncate font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title={url || displayTitle}
          >
            {displayTitle}
          </div>
        }
        subtitle={
          subtitle ? (
            <span
              className="truncate"
              style={{ color: err ? HUE.crimson : automating ? HUE.cyan : undefined }}
              title={
                err
                  ? err
                  : automating
                    ? `automating · ${automatingNames.join(", ")}`
                    : subtitle
              }
            >
              {subtitle}
            </span>
          ) : undefined
        }
        activity={activity}
      />
    </div>
  );
}
