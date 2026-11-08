/**
 * `automation.firing`: the closed row by which a firing on an automation's
 * machine reaches the machine that rules the canvas (plan 0.11/05, S3;
 * machines.md Rule 4).
 *
 * A firing crosses as revisions: the first row is its first state worth
 * showing — fired, skipped, or still claimed when the pass ends held — and
 * each later change is the next rev carrying the whole Firing. The receiver
 * keeps the highest rev per firingId and folds it into `automation_firings`,
 * so a held firing that later resolves is an update to that id, never a
 * second row.
 *
 * Only the machine that minted the firingId ever writes a rev for it. Every
 * rev states `claimSeq`, the canvas count the claim was minted under, and is
 * admitted only from the machine the automation ran on at that count — so a
 * move mid-firing leaves the in-flight firing to settle on the old machine,
 * and a rev for that id from the new machine is refused.
 */
import { Schema } from "effect";
import { AutomationId, Firing, FiringId } from "./automation";
import { AutomationNodeId } from "./mail-author";
import { Seq } from "./model";

/** The canvas count of the claim (rev 0's count), restated on every rev. */
const ClaimSeq = Seq;

/**
 * One revision of a firing. `rev` counts crossings, not local mutations:
 * the transient claim never crosses, so rev 0 is the first state worth
 * showing and later changes are rev 1, 2, ... in write order.
 */
export const AutomationFiringResult = Schema.Struct({
  operation: Schema.Literal("automation.firing"),
  automationNode: AutomationNodeId,
  automationId: AutomationId,
  firingId: FiringId,
  claimSeq: ClaimSeq,
  rev: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  firing: Firing,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (body) =>
        (body.firing.firingId === body.firingId && body.firing.automationId === body.automationId) ||
        "a firing row carries the firing it revises",
    ),
  ),
);
export type AutomationFiringResult = typeof AutomationFiringResult.Type;

/** A revision's item id derives from its firing and rev: one rev crosses once. */
export const automationFiringItemId = (body: {
  readonly firingId: string;
  readonly rev: number;
}): string => `automation-firing:${body.firingId}:${body.rev}`;
