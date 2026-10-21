/**
 * Region reach at ruling (docs/plans/0.10/01-region-binding.md rule 3, 02
 * "Invariants under partition"). The editing machine rules a command against
 * reach on its own canvas at the ruling, not at the command's basis; the
 * writing machine runs the same check on its copy for the pending overlay.
 * Pure: the caller hands over the canvas it holds and who wrote each
 * automation.
 */
import type { NodeId } from "./model/base";
import { automationTargets, reaches, type AutomationAuthor, type ReachCanvas } from "./region-reach";
import type { ResourceActor, ResourceRef, RulingContext } from "./resource-command";

/**
 * Reach for every actor kind. The operator reaches every node on the canvas;
 * a seat, which must be an agent node, what `reaches` says from it; an automation what
 * `automationTargets` gives it, with its author as it stands now. A target
 * or actor node the canvas does not hold is out of reach, and so is an
 * automation whose author is not known.
 */
export const rulingContextOf = (
  canvas: ReachCanvas,
  automationAuthor: (automationNodeId: NodeId) => AutomationAuthor | undefined,
): RulingContext => ({
  inReach: (actor: ResourceActor, target: ResourceRef): boolean => {
    const targetId = target.nodeId as string as NodeId;
    if (!canvas.nodes.has(targetId)) return false;
    switch (actor.kind) {
      case "operator":
        return true;
      case "seat": {
        // Only a seat acts (01 rule 4): a peer row or any other node never does.
        const seat = actor.nodeId as string as NodeId;
        return canvas.nodes.get(seat)?.kind === "agent" && reaches(canvas, seat, targetId);
      }
      case "automation": {
        const automation = actor.nodeId as string as NodeId;
        const author = automationAuthor(automation);
        return author !== undefined && automationTargets(canvas, automation, author).some((node) => node.id === targetId);
      }
    }
  },
});
