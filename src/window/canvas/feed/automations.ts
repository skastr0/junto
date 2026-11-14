/**
 * The Automations nodes' one list read each, kept for every feed consumer:
 * node chrome (status, spoken kind) and the kind live facts (line, ledger).
 * One retention per canvas, refcounted — the card's own read
 * (useAutomationList) is the same `automationsSource().list` call, re-read
 * on mount-equivalent and after every source change.
 */
import { observable, observe, type Observable } from "@legendapp/state";
import type { AutomationListResponse } from "@shared/automation";
import type { NodeId } from "@shared/physics/schema";
import { automationsSource } from "../../lib/automations-source";
import { modelStore } from "../../lib/use-model";

type Shared = {
  readonly facts: Observable<Record<string, AutomationListResponse | undefined>>;
  users: number;
  readonly stops: Array<() => void>;
};

const shared = new Map<string, Shared>();

const retainShared = (canvasName: string): Shared => {
  const held = shared.get(canvasName);
  if (held !== undefined) {
    held.users += 1;
    return held;
  }

  const facts = observable<Record<string, AutomationListResponse | undefined>>({});
  const stops: Array<() => void> = [];
  let automationSig = "";

  const load = async (): Promise<void> => {
    const model = modelStore.canvas$(canvasName);
    const targets: string[] = [];
    for (const id of model.nodeIds.peek()) {
      if (model.nodes[id].kind.peek() === "automations") targets.push(id);
    }
    automationSig = targets.slice().sort().join("");
    await Promise.all(
      targets.map(async (id) => {
        try {
          facts[id].set(await automationsSource().list(canvasName, id as NodeId));
        } catch {
          // A failed read keeps the last answer, as the card's does.
        }
      }),
    );
    const wanted = new Set(targets);
    for (const id of Object.keys(facts.peek())) {
      if (!wanted.has(id)) facts[id].delete();
    }
  };

  stops.push(automationsSource().subscribe(() => void load()));
  stops.push(
    observe(() => {
      const model = modelStore.canvas$(canvasName);
      const ids = model.nodeIds.get();
      const automationIds: string[] = [];
      for (const id of ids) {
        if (model.nodes[id].kind.get() === "automations") automationIds.push(id);
      }
      // The automations set is tracked through the list reads above; reload
      // when the canvas's automations nodes change.
      const sig = automationIds.slice().sort().join("");
      if (sig !== automationSig) void load();
    }),
  );

  const entry: Shared = { facts, users: 1, stops };
  shared.set(canvasName, entry);
  return entry;
};

/**
 * The canvas's automations list reads, shared by every feed consumer. The
 * returned release drops this caller's hold; the reads stop with the last.
 */
export const retainAutomationFacts = (
  canvasName: string,
): { readonly facts: Observable<Record<string, AutomationListResponse | undefined>>; readonly release: () => void } => {
  const entry = retainShared(canvasName);
  let released = false;
  return {
    facts: entry.facts,
    release: () => {
      if (released) return;
      released = true;
      entry.users -= 1;
      if (entry.users > 0) return;
      shared.delete(canvasName);
      for (const stop of entry.stops.reverse()) stop();
      entry.facts.set({});
    },
  };
};
