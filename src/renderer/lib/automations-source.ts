/**
 * Where the Automations node reads and writes its automations and their
 * firings (plan 0.10/07). One interface, so the pane never knows which side
 * answers it.
 *
 * Writes are `AutomationOp`s (automation.ts) on a resource command (02) whose
 * target is the automation item; reads are the `AutomationList` and
 * `AutomationFirings` payloads. A write comes back applied or refused with its
 * reason, never queued: off the editing machine it is refused `not_available`
 * with a next step. A stale edit carries the head it lost to in `expected`.
 *
 * Stand-in: until canvas-automation serves these over IPC (track C5),
 * `makeLocalAutomationsSource` holds them in this window's memory under the
 * same rules.
 */
import { useEffect, useState } from "react";
import { Result } from "effect";
import {
  AutomationVersion,
  FIRINGS_PAGE_MAX,
  decodeAutomation,
  lastOutcomeOf,
  type Automation,
  type AutomationCodePutResponse,
  type AutomationCodeReadResponse,
  type AutomationAuthor,
  type AutomationFiringsRequest,
  type AutomationFiringsResponse,
  type AutomationId,
  type AutomationListResponse,
  type AutomationOp,
  type Firing,
  type LastOutcome,
} from "@shared/automation";
import type { NodeId } from "@shared/physics/schema";
import type { Refusal } from "@shared/resource-command";
import type { ContentRef } from "@shared/wire/content-ref";

export type ApplyResult =
  | { readonly kind: "applied"; readonly automation?: Automation }
  | { readonly kind: "refused"; readonly refusal: Refusal };

export interface AutomationsSource {
  readonly list: (canvasName: string, nodeId: NodeId) => Promise<AutomationListResponse>;
  readonly firings: (canvasName: string, request: AutomationFiringsRequest) => Promise<AutomationFiringsResponse>;
  /** One op on one automation. `create` names its own id; every other op targets `automationId`. */
  readonly apply: (canvasName: string, nodeId: NodeId, automationId: AutomationId, op: AutomationOp) => Promise<ApplyResult>;
  /** A code step's text put in the content store; the automation then names the ref. */
  readonly codePut: (canvasName: string, text: string) => Promise<AutomationCodePutResponse>;
  /** A code step's text read back from this machine's content store. */
  readonly codeRead: (canvasName: string, ref: ContentRef) => Promise<AutomationCodeReadResponse>;
  /** Called after any change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

const keyOf = (canvasName: string, id: string): string => `${canvasName}\u0000${id}`;

const refused = (reason: Refusal["reason"], message: string, expected?: unknown): ApplyResult => ({
  kind: "refused",
  refusal: { reason, message, ...(expected === undefined ? {} : { expected }) },
});

/** An in-memory source, as the stand-in and for tests. Every author is `author`, as main would set it. */
export const makeLocalAutomationsSource = (
  author: AutomationAuthor = { kind: "operator" },
): AutomationsSource & {
  /** Records a firing, as the runner will. */
  readonly record: (canvasName: string, firing: Firing) => void;
} => {
  const automations = new Map<string, Automation>();
  const firings = new Map<string, ReadonlyArray<Firing>>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const put = (canvasName: string, raw: Automation): ApplyResult => {
    const decoded = decodeAutomation(raw);
    if (Result.isFailure(decoded)) return refused("invalid_input", String(decoded.failure));
    automations.set(keyOf(canvasName, decoded.success.automationId), decoded.success);
    changed();
    return { kind: "applied", automation: decoded.success };
  };

  return {
    list: async (canvasName, nodeId) => {
      const listed = [...automations.entries()]
        .filter(([at, automation]) => at === keyOf(canvasName, automation.automationId) && automation.nodeId === nodeId)
        .map(([, automation]) => automation);
      // As main reads it: each automation's newest firing, absent when it never fired.
      const lastOutcomes: Record<string, LastOutcome> = {};
      for (const automation of listed) {
        const newest = [...(firings.get(keyOf(canvasName, automation.automationId)) ?? [])].sort((a, b) => b.at - a.at)[0];
        if (newest !== undefined) lastOutcomes[automation.automationId] = lastOutcomeOf(newest.outcome);
      }
      return { automations: listed, lastOutcomes };
    },
    // Code lives in main's content store: without main there is none to read or write.
    codePut: async () => ({
      kind: "refused",
      refusal: {
        reason: "not_available",
        message: "a code step's code is stored by the app",
        next_step: "Open this canvas in Junto to write it",
      },
    }),
    codeRead: async () => ({
      kind: "refused",
      refusal: {
        reason: "not_available",
        message: "a code step's code is stored by the app",
        next_step: "Open this canvas in Junto to read it",
      },
    }),
    firings: async (canvasName, request) => {
      const newestFirst = [...(firings.get(keyOf(canvasName, request.automationId)) ?? [])].sort((a, b) => b.at - a.at);
      const from = request.before === undefined ? 0 : newestFirst.findIndex((firing) => firing.firingId === request.before) + 1;
      return { firings: (from === 0 && request.before !== undefined ? [] : newestFirst.slice(from)).slice(0, request.limit ?? FIRINGS_PAGE_MAX) };
    },
    apply: async (canvasName, nodeId, automationId, op) => {
      const key = keyOf(canvasName, op.kind === "create" ? op.automationId : automationId);
      const current = automations.get(key);
      if (op.kind !== "create" && current === undefined) return refused("unknown_target", "no such automation");
      switch (op.kind) {
        case "create":
          if (current !== undefined) return refused("invalid_transition", "that automation exists");
          return put(canvasName, {
            automationId: op.automationId,
            nodeId,
            author,
            version: AutomationVersion.make(1),
            enabled: op.enabled,
            ...op.definition,
          });
        case "edit":
          if (current!.version !== op.baseVersion) return refused("stale", "edited since", current!.version);
          // A whole replace: what the new definition leaves out (its conditions, say) is gone.
          return put(canvasName, {
            automationId: current!.automationId,
            nodeId: current!.nodeId,
            author: current!.author,
            version: AutomationVersion.make(current!.version + 1),
            enabled: current!.enabled,
            ...op.definition,
          });
        case "set-enabled":
          return put(canvasName, { ...current!, enabled: op.enabled });
        case "set-machine":
          return put(canvasName, { ...current!, machine: op.machine });
        case "archive":
          automations.delete(key);
          changed();
          return { kind: "applied" };
        case "run":
          return { kind: "applied", automation: current! };
        default:
          return op satisfies never;
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    record: (canvasName, firing) => {
      const key = keyOf(canvasName, firing.automationId);
      firings.set(key, [...(firings.get(key) ?? []), firing]);
      changed();
    },
  };
};

let source: AutomationsSource = makeLocalAutomationsSource();

/** The window's source. Tests and the real wiring swap it in. */
export const automationsSource = (): AutomationsSource => source;
export const setAutomationsSource = (next: AutomationsSource): void => {
  source = next;
};

/** Reads `read` now and again after every change, until unmounted or its inputs change. */
const useRead = <A>(read: () => Promise<A>, empty: A, deps: ReadonlyArray<unknown>): A => {
  const [value, setValue] = useState<A>(empty);
  useEffect(() => {
    let live = true;
    // New inputs show nothing until their own answer, never the last inputs' answer.
    setValue(empty);
    // A read that fails keeps what was shown; the next change reads again.
    const load = (): void => {
      read().then(
        (next) => {
          if (live) setValue(next);
        },
        () => undefined,
      );
    };
    load();
    const stop = automationsSource().subscribe(load);
    return () => {
      live = false;
      stop();
    };
  }, deps);
  return value;
};

const NO_AUTOMATIONS: ReadonlyArray<Automation> = [];
const NO_FIRINGS: ReadonlyArray<Firing> = [];

/** The node's automations, kept current. */
export const useAutomations = (canvasName: string, nodeId: NodeId): ReadonlyArray<Automation> =>
  useRead(async () => (await automationsSource().list(canvasName, nodeId)).automations, NO_AUTOMATIONS, [canvasName, nodeId]);

const NO_LIST: AutomationListResponse = { automations: NO_AUTOMATIONS, lastOutcomes: {} };

/** The node's automations with each one's last firing outcome, kept current: the card's one read. */
export const useAutomationList = (canvasName: string, nodeId: NodeId): AutomationListResponse =>
  useRead(() => automationsSource().list(canvasName, nodeId), NO_LIST, [canvasName, nodeId]);

/** One automation's latest page of firings, newest first, kept current. */
export const useFirings = (canvasName: string, automationId: AutomationId | undefined): ReadonlyArray<Firing> =>
  useRead(
    async () => (automationId === undefined ? NO_FIRINGS : (await automationsSource().firings(canvasName, { automationId })).firings),
    NO_FIRINGS,
    [canvasName, automationId],
  );
