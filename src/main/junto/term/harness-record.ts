/**
 * The harness record as main sees it: the shared record joined with the
 * screen rule pack, the session store, the model list, how a seat comes by
 * its session id and any process that runs beside the seat, which live beside
 * the code that runs them.
 */
import { type HarnessRecord, harnessRecordFor } from "../../../shared/harness-records";
import { HARNESS_IDS, type HarnessId } from "../../../shared/managed-terminal-templates";
import { rulePackFor } from "./agent-state/rules";
import type { SeatRulePack } from "./agent-state/types";
import { DEVIN_PROOF_RETRY_DELAYS_MS, discoverDevinSessionId } from "./devin-session-capture";
import { HARNESS_SESSION_STORES, type HarnessSessionStore } from "./session-existence";
import { extractSessionIdFromText } from "./session-id-store";
import { isAmpThreadId, provisionAmpThread } from "./templates/amp-thread";
import { HARNESS_MODEL_LISTS, type HarnessModelList } from "./templates/enumerate-dispatch";
import { extractKimiSessionIdFromText } from "./templates/kimi-session";

/**
 * How a seat comes by its session id, beyond pinning one at spawn (the
 * template's `sessionIdFlag`) and finding one in the store after spawn (the
 * session store's `spawned` block).
 */
export type HarnessSessionOrigin = {
  /**
   * The harness's own CLI creates the session before the PTY opens, because
   * it lives on the harness's side (Amp threads). A stored id is reused only
   * while it still has the harness's shape.
   */
  readonly provision?: {
    readonly isSessionId: (value: string) => boolean;
    readonly mint: (input: {
      readonly cwd?: string;
      readonly mode?: string;
      readonly extraArgs?: readonly string[];
    }) => Promise<{ readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly reason: string }>;
  };
  /**
   * Looked up from the spawned process (Devin writes a lock file from a
   * descendant). The answer is a candidate: it is stored only once the store
   * proves it, retried on these delays.
   */
  readonly fromProcess?: {
    readonly discover: (input: { readonly pid: number; readonly stillRunning: () => boolean }) => Promise<string | undefined>;
    readonly proofRetryDelaysMs: readonly number[];
  };
  /** Reads an id the harness prints. Untrusted PTY text: a diagnostic, never resume proof. */
  readonly printed: (text: string) => string | undefined;
};

/**
 * A process Junto runs beside the seat's terminal. Prime Agent's daemon owns
 * the agent and reports its state; the PTY attaches to it.
 */
export type HarnessSidecar = "primeAgentDaemon";

const PRINTED_ONLY: HarnessSessionOrigin = { printed: extractSessionIdFromText };

const HARNESS_SESSION_ORIGINS: Readonly<Partial<Record<HarnessId, HarnessSessionOrigin>>> = {
  amp: {
    printed: extractSessionIdFromText,
    provision: {
      isSessionId: isAmpThreadId,
      mint: async (input) => {
        const minted = await provisionAmpThread(input);
        return minted.ok
          ? { ok: true, sessionId: minted.threadId }
          : { ok: false, reason: minted.failure.reason };
      },
    },
  },
  devin: {
    printed: extractSessionIdFromText,
    fromProcess: { discover: discoverDevinSessionId, proofRetryDelaysMs: DEVIN_PROOF_RETRY_DELAYS_MS },
  },
  // Kimi's welcome card prints a blank `Session:` line at spawn; its own
  // reader waits for a filled one.
  kimi: { printed: extractKimiSessionIdFromText },
};

const HARNESS_SIDECARS: Readonly<Partial<Record<HarnessId, HarnessSidecar>>> = {
  "prime-agent": "primeAgentDaemon",
};

export type HarnessRuntimeRecord = HarnessRecord & {
  readonly rulePack: SeatRulePack;
  /** Where the harness keeps its sessions; undefined when it keeps none Junto can read. */
  readonly session: HarnessSessionStore | undefined;
  /** How the picker lists this harness's models. */
  readonly models: HarnessModelList;
  readonly sessionOrigin: HarnessSessionOrigin;
  readonly sidecar: HarnessSidecar | undefined;
};

let records: ReadonlyMap<string, HarnessRuntimeRecord> | undefined;

const runtimeRecords = (): ReadonlyMap<string, HarnessRuntimeRecord> => {
  if (records !== undefined) return records;
  const built = new Map<string, HarnessRuntimeRecord>();
  for (const harness of HARNESS_IDS) {
    const record = harnessRecordFor(harness)!;
    built.set(harness, {
      ...record,
      rulePack: rulePackFor(harness),
      session: HARNESS_SESSION_STORES[harness],
      models: HARNESS_MODEL_LISTS[harness],
      sessionOrigin: HARNESS_SESSION_ORIGINS[harness] ?? PRINTED_ONLY,
      sidecar: HARNESS_SIDECARS[harness],
    });
  }
  records = built;
  return built;
};

/** The runtime record for a harness id, or undefined when it names no template. */
export const harnessRuntimeRecordFor = (harness: string | undefined): HarnessRuntimeRecord | undefined =>
  harness === undefined ? undefined : runtimeRecords().get(harness);

/** An id the harness printed in this text, read the harness's own way (or the generic way when unknown). */
export const printedSessionIdOf = (harness: string | undefined, text: string): string | undefined =>
  (harnessRuntimeRecordFor(harness)?.sessionOrigin ?? PRINTED_ONLY).printed(text);
