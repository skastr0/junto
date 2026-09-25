/**
 * Health section of the seat sidebar: Jev's advisory reading of how this
 * agent's thread is going, good or bad, with its confidence and age.
 *
 * AI reading only. What the agent declared about itself lives in the Signals
 * section; the two are separate axes and this section never restates one.
 * Renders nothing when the sidecar has no reading for the seat (off, no key,
 * not yet assessed, or nothing decisive).
 */
import type { CanvasNode } from "@shared/canvas";
import { bindingIdForNode } from "../../lib/agent-seat-state";
import { threadHealthSectionModel, useThreadHealth } from "../../lib/thread-health";
import { Chip, SidebarSection, StatusDot } from "../ui";

export function ThreadHealthSection({ node }: { readonly node: CanvasNode }) {
  const view = useThreadHealth(bindingIdForNode(node));
  if (view === undefined) return null;
  const model = threadHealthSectionModel(view);
  return (
    <SidebarSection
      storageKey="seat-sidebar:health"
      title="health"
      meta={model.meta}
      testId="seat-health-section"
    >
      <div
        className="flex items-center gap-2"
        data-health-tone={view.tone}
        data-health-freshness={view.freshness}
        aria-label={view.label}
      >
        <StatusDot tone={model.tone} />
        <span className={`font-mono text-[12px] ${view.freshness === "stale" ? "text-dim" : "text-ink"}`}>
          AI reads {model.headline}
        </span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">{model.confidence}</span>
      </div>
      {model.alsoRead.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-faint">also</span>
          {model.alsoRead.map((entry) => (
            <Chip key={entry.label} tone={entry.tone}>
              {entry.label} {entry.confidence}
            </Chip>
          ))}
        </div>
      ) : null}
      <p className="mt-1.5 text-[10px] leading-snug text-faint">{model.provenance}</p>
    </SidebarSection>
  );
}
