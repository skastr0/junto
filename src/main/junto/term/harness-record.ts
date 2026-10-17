/**
 * The harness record as main sees it: the shared record joined with the
 * screen rule pack, which lives beside the engine that runs it.
 */
import { type HarnessRecord, harnessRecordFor } from "../../../shared/harness-records";
import { rulePackFor } from "./agent-state/rules";
import type { SeatRulePack } from "./agent-state/types";

export type HarnessRuntimeRecord = HarnessRecord & { readonly rulePack: SeatRulePack };

/** The runtime record for a harness id, or undefined when it names no template. */
export const harnessRuntimeRecordFor = (harness: string | undefined): HarnessRuntimeRecord | undefined => {
  const record = harnessRecordFor(harness);
  return record === undefined ? undefined : { ...record, rulePack: rulePackFor(record.harness) };
};
