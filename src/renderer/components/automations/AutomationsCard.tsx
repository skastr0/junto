/**
 * The Automations node on the canvas, in the Spines language
 * (docs/node-card-language.md): the chip with its count, a meta line of how
 * many are on and off, a row per automation (on or off, name, trigger in
 * words), and Failed or Off as the tag. All of it from the node's one list
 * read (automations-card.ts): no firing read per automation, at any zoom.
 * A Failed tag also tells the region, so its frame leans to it far out.
 */
import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { Workflow } from "lucide-react";
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
import { SpineCard } from "../nodes/SpineCard";
import { useTargetNames } from "../../lib/automation-names";
import "./automations.css";

// Names in a change trigger, read once per node with the operator's reach (the widest).
const OPERATOR = { kind: "operator" } as const;
// Until the read lands: one object, so the facts are not recomputed each render.
const NO_OUTCOMES: Readonly<Record<string, LastOutcome>> = {};

/** On is a filled dot, off a hollow ring: a shape, never colour alone. */
function OnMark({ on }: { readonly on: boolean }) {
  return <span className="automation-card__mark" data-on={on ? "true" : "false"} />;
}

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
      <SpineCard
        glyph={<Workflow />}
        hue="amber"
        name={name}
        // Renaming keeps the card: the field stands in for the name in the chip.
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
        count={facts.count}
        status={facts.status}
        body={{
          kind: "spine",
          meta: facts.meta,
          rows: facts.rows.map((row) => ({
            key: row.automationId,
            mark: <OnMark on={row.on} />,
            // The mark is hidden from a screen reader, so off and failed are said in
            // words; the closing comma parts the name from the trigger after it.
            text: (
              <>
                {row.name}
                <span className="sr-only">
                  {row.on ? "" : ", off"}
                  {row.failed ? ", failed" : ""}
                  {", "}
                </span>
              </>
            ),
            detail: row.trigger,
            ...(row.failed ? { tone: "crimson" as const } : {}),
          })),
          more: facts.more,
        }}
      />
    </div>
  );
}
