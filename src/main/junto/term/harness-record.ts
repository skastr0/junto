/**
 * The harness record as main sees it: the shared record joined with the
 * screen rule pack, the session store and the model list, which live beside
 * the code that runs them.
 */
import { type HarnessRecord, harnessRecordFor } from "../../../shared/harness-records";
import { rulePackFor } from "./agent-state/rules";
import type { SeatRulePack } from "./agent-state/types";
import { HARNESS_SESSION_STORES, type HarnessSessionStore } from "./session-existence";
import { HARNESS_MODEL_LISTS, type HarnessModelList } from "./templates/enumerate-dispatch";

export type HarnessRuntimeRecord = HarnessRecord & {
  readonly rulePack: SeatRulePack;
  /** Where the harness keeps its sessions; undefined when it keeps none Junto can read. */
  readonly session: HarnessSessionStore | undefined;
  /** How the picker lists this harness's models. */
  readonly models: HarnessModelList;
};

/** The runtime record for a harness id, or undefined when it names no template. */
export const harnessRuntimeRecordFor = (harness: string | undefined): HarnessRuntimeRecord | undefined => {
  const record = harnessRecordFor(harness);
  return record === undefined
    ? undefined
    : {
        ...record,
        rulePack: rulePackFor(record.harness),
        session: HARNESS_SESSION_STORES[record.harness],
        models: HARNESS_MODEL_LISTS[record.harness],
      };
};
