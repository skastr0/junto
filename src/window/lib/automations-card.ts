/**
 * What the Automations node's card says, in the Spines language
 * (docs/node-card-language.md): the chip's count, the spine's meta line and
 * rows, and the one status tag. Pure, so the card reads it from the node's
 * one list read and nothing else: no firing read per automation, at any zoom.
 *
 * Status: Failed when any automation's last firing failed, else Off when
 * every one is off, else nothing. Failed wins over Off (a failure needs the
 * operator). Main derives "failed" for the list (product-automation): the
 * last firing fired and an action was refused. A skip (condition unmet, a
 * limit reached) is by design and never fails.
 */
import type { Automation, AutomationId, LastOutcome } from "@shared/automation";
import { draftOf, triggerWords, type NameOf } from "./automation-editor";

/** Rows the spine shows before a `+N more` row. */
export const AUTOMATIONS_CARD_ROWS = 4;

export type AutomationsCardRow = {
  readonly automationId: AutomationId;
  readonly name: string;
  readonly on: boolean;
  /** The trigger in words: "weekdays 09:00, UTC". */
  readonly trigger: string;
  readonly failed: boolean;
};

export type AutomationsCardStatus = "failed" | "off";

export type AutomationsCardFacts = {
  /** The chip's count: every automation, on or off. */
  readonly count: number;
  /** The spine's first line. */
  readonly meta: string;
  readonly rows: ReadonlyArray<AutomationsCardRow>;
  /** Automations past the shown rows, for `+N more`; 0 shows no row. */
  readonly more: number;
  readonly status: AutomationsCardStatus | undefined;
  /** On, off and failed counts, for the kind seat's ledger band. */
  readonly ledger: { readonly on: number; readonly off: number; readonly failed: number };
};

export const automationsCardFacts = (
  automations: ReadonlyArray<Automation>,
  /** The list read's `lastOutcomes`: an automation that never fired has no key. */
  lastOutcomes: Readonly<Record<string, LastOutcome>>,
  nameOf: NameOf,
): AutomationsCardFacts => {
  const on = automations.filter((automation) => automation.enabled).length;
  const failed = new Set(
    automations.filter((automation) => lastOutcomes[automation.automationId] === "failed").map((automation) => automation.automationId),
  );
  // A failed one shows first, so it is never cut behind `+N more`.
  const ordered = [...automations].sort((a, b) => Number(failed.has(b.automationId)) - Number(failed.has(a.automationId)));
  const rows = ordered.slice(0, AUTOMATIONS_CARD_ROWS).map((automation) => ({
    automationId: automation.automationId,
    name: automation.name,
    on: automation.enabled,
    trigger: triggerWords(draftOf(automation).trigger, nameOf, (raising) =>
      automations.find((other) => other.nodeId === raising.node && other.automationId === raising.automationId)?.name,
    ),
    failed: failed.has(automation.automationId),
  }));
  return {
    count: automations.length,
    meta: automations.length === 0 ? "No automations yet" : `${on} on, ${automations.length - on} off`,
    rows,
    more: Math.max(0, automations.length - AUTOMATIONS_CARD_ROWS),
    status: failed.size > 0 ? "failed" : automations.length > 0 && on === 0 ? "off" : undefined,
    ledger: { on, off: automations.length - on, failed: failed.size },
  };
};
