import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { Ban } from "lucide-react";
import {
  formatRankedStoppageLine,
  rankStoppageSeeds,
  type RankedStoppage,
} from "@shared/impact";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { deriveOccupancy, type OccupancySpectrumName } from "@shared/occupancy";
import { HUE } from "../../lib/theme";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { chatActivityFeed } from "../../lib/occupancy-feed";
import { chatCoarse$ } from "../../lib/chat-state";

const MAX_VISIBLE = 4;

/** Focus + select seed so Canvas impact mode paints the cone. */
const enterImpactOnSeed = (seedNodeId: string): void => {
  state$.selectedNodeId.set(seedNodeId);
  state$.selectedNodeIds.set([seedNodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(seedNodeId);
};

function StoppageRow({
  ranked,
  occupancyByNodeId,
  active,
}: {
  readonly ranked: RankedStoppage;
  readonly occupancyByNodeId: ReadonlyMap<string, OccupancySpectrumName> | undefined;
  readonly active: boolean;
}) {
  const doc = use$(state$.doc);
  const line = formatRankedStoppageLine(ranked, {
    titleOf: (id) => {
      const node = doc.nodes.find((n) => n.id === id);
      return node ? nodeTitle(node) : id;
    },
    occupancyByNodeId,
  });
  return (
    <button
      type="button"
      className={`rts-stoppage-row${active ? " is-active" : ""}`}
      style={{ color: HUE.crimson }}
      title={`${line} · ${ranked.clearAction}`}
      aria-label={`Stoppage: ${line}. Enter impact mode.`}
      onClick={() => enterImpactOnSeed(ranked.seedNodeId)}
    >
      <Ban size={10} aria-hidden />
      <span className="rts-stoppage-row__line">{line}</span>
    </button>
  );
}

/**
 * Blast-radius ranked stoppage seeds for the RTS bar.
 * Click a row → select seed → impact mode centers on that cone.
 */
export function StoppageRank() {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const selectedNodeId = use$(state$.selectedNodeId);
  const chatCoarse = use$(chatCoarse$);

  const ranked = useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    return rankStoppageSeeds(doc, graph);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorRefs, canvasName, doc, execution, executionRev]);

  const occupancyByNodeId = useMemo(() => {
    const feed = chatActivityFeed(doc, chatCoarse ?? {});
    const leadIds = new Set(ranked.flatMap((r) => r.attentionLeadIds));
    if (leadIds.size === 0) return undefined;
    const map = new Map<string, OccupancySpectrumName>();
    for (const id of leadIds) {
      const clue = feed.clueFor(id);
      // Only mark staffing when we have a clue (agent seat or flags).
      // Absent clue → unknown (no unstaffed mark).
      if (!clue) continue;
      map.set(
        id,
        deriveOccupancy({
          hasOccupant: clue.hasOccupant,
          activity: clue.activity,
          lastSeenAtMs: clue.lastSeenAtMs,
          flags: clue.flags,
          nowMs: Date.now(),
        }),
      );
    }
    return map.size > 0 ? map : undefined;
  }, [doc, chatCoarse, ranked]);

  if (ranked.length === 0) return null;

  const visible = ranked.slice(0, MAX_VISIBLE);

  return (
    <div className="rts-stoppage" aria-label="Stoppage ranking by blast radius">
      <div className="rts-stoppage__label">
        stoppage · by impact
        {ranked.length > MAX_VISIBLE ? (
          <span className="rts-stoppage__more"> +{ranked.length - MAX_VISIBLE}</span>
        ) : null}
      </div>
      <div className="rts-stoppage__list">
        {visible.map((row) => (
          <StoppageRow
            key={row.seedNodeId}
            ranked={row}
            occupancyByNodeId={occupancyByNodeId}
            active={selectedNodeId === row.seedNodeId}
          />
        ))}
      </div>
    </div>
  );
}
