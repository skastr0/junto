/**
 * The Automations node on the canvas, a kind seat: a line of how many are on
 * and off, the band's on, off and failed marks, and the ring saying failed or
 * off. The automations themselves are in the detail view. All of it from the
 * node's one list read (automations-card.ts): no firing read per automation,
 * at any zoom. Failed also tells the region, so its frame leans to it far out.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { asNodeId } from "@shared/physics/schema";
import { titleOf } from "@shared/model/title";
import type { LastOutcome } from "@shared/automation";
import { RegionUrgency } from "@shared/wire/urgency";
import { automationsCardFacts } from "../../lib/automations-card";
import { useAutomationList } from "../../lib/automations-source";
import { useAutomationTargets } from "../../lib/mention-sources";
import { renamed } from "../../lib/model-edits";
import { commitCommands } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { useNodeUrgency } from "../../lib/use-node-urgency";
import { useNodeValue } from "../../lib/use-model";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { KindCard } from "../nodes/SpineCard";
import { useTargetNames } from "../../lib/automation-names";
import "./automations.css";

// Names in a change trigger, read once per node with the operator's reach (the widest).
const OPERATOR = { kind: "operator" } as const;
// Until the read lands: one object, so the facts are not recomputed each render.
const NO_OUTCOMES: Readonly<Record<string, LastOutcome>> = {};

export function AutomationsCard({
  nodeId,
  renaming,
  onRenameDone,
}: {
  readonly nodeId: string;
  readonly renaming: boolean;
  readonly onRenameDone: () => void;
}) {
  const canvasName = use$(state$.canvasName) || "";
  const name = useNodeValue(canvasName, nodeId, (node) => (node === undefined ? "Automations" : titleOf(node)));
  const { automations, lastOutcomes } = useAutomationList(canvasName, asNodeId(nodeId));
  const nameOf = useTargetNames(useAutomationTargets(canvasName, asNodeId(nodeId), OPERATOR), canvasName);
  const facts = useMemo(
    () => automationsCardFacts(automations, lastOutcomes ?? NO_OUTCOMES, nameOf),
    [automations, lastOutcomes, nameOf],
  );
  // Failed counts as blocked for the region frame; it clears when the card goes.
  useNodeUrgency(nodeId, facts.status === "failed" ? RegionUrgency.group.blocked : undefined);

  return (
    <div data-testid="automations-card">
      <KindCard
        kind="automations"
        name={name}
        // Renaming keeps the card: the field stands in for the name.
        {...(renaming
          ? {
              nameEditor: (
                <FirstLineRenameInput
                  initial={name}
                  ariaLabel="Rename automations"
                  onCommit={(next) => commitCommands((canvas) => renamed(canvas, nodeId, next))}
                  onDone={onRenameDone}
                />
              ),
            }
          : {})}
        status={facts.status}
        line={facts.meta}
        ledger={{ kind: "automations", ...facts.ledger }}
      />
    </div>
  );
}
