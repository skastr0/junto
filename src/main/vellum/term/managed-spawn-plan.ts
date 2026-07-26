/**
 * Re-plan managed launch at spawn time from live canvas edges.
 * Document may store unconnected argv (silence at authoring); spawn applies
 * Tier A flags / arms Tier B firstTyped when edges connect the seat.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import {
  resolveManagedLaunchPlan,
  type ManagedLaunchChoices,
  type ManagedLaunchPlan,
} from "@shared/managed-terminal-launch";
import { isHarnessId, type HarnessId } from "@shared/managed-terminal-templates";
import type { TerminalLaunch } from "@shared/terminal";

const WORK_KINDS = new Set(["task", "tasks", "requests", "request"]);

/** True when the node has an undirected edge to a work sink (tasks/requests). */
export const nodeIsConnectedToWork = (
  doc: CanvasDoc,
  nodeId: string,
): boolean => {
  const neighbors = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === nodeId) neighbors.add(edge.toNode);
    if (edge.toNode === nodeId) neighbors.add(edge.fromNode);
  }
  for (const id of neighbors) {
    const n = doc.nodes.find((x) => x.id === id);
    const kind = n?.ether?.entity?.kind;
    if (kind && WORK_KINDS.has(kind)) return true;
  }
  return false;
};

export const connectedTargetsForNode = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<{ id: string; kind?: string; summary?: string }> => {
  const neighbors = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === nodeId) neighbors.add(edge.toNode);
    if (edge.toNode === nodeId) neighbors.add(edge.fromNode);
  }
  const out: Array<{ id: string; kind?: string; summary?: string }> = [];
  for (const id of neighbors) {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) continue;
    const kind = n.ether?.entity?.kind;
    const summary =
      n.type === "text" ? n.text.split("\n")[0]?.trim() : undefined;
    out.push({
      id,
      ...(kind ? { kind } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return out;
};

export type SpawnPlanInput = {
  readonly doc?: CanvasDoc;
  readonly nodeId?: string;
  readonly harness?: string;
  readonly documentLaunch?: TerminalLaunch;
  readonly agentKey?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
};

/**
 * Build spawn plan. When harness is known and doc shows work edges, inject
 * doctrine (Tier A argv / Tier B firstTyped). Unconnected → silence.
 */
export const planManagedSpawn = (input: SpawnPlanInput): ManagedLaunchPlan | undefined => {
  const harnessRaw = input.harness?.trim();
  if (!harnessRaw || !isHarnessId(harnessRaw)) return undefined;
  const harness: HarnessId = harnessRaw;

  const connected =
    input.doc && input.nodeId
      ? nodeIsConnectedToWork(input.doc, input.nodeId)
      : false;

  const choices: ManagedLaunchChoices = {
    injection: {
      connected,
      ...(input.nodeId
        ? { seatRef: input.nodeId }
        : {}),
      ...(input.doc && input.nodeId
        ? { connectedTargets: connectedTargetsForNode(input.doc, input.nodeId) }
        : {}),
    },
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.cwd
      ? { cwd: input.cwd }
      : input.documentLaunch?.cwd
        ? { cwd: input.documentLaunch.cwd }
        : {}),
  };

  return resolveManagedLaunchPlan(harness, choices);
};

/** Prefer re-planned launch when injection applies; else document launch. */
export const launchForManagedSpawn = (
  input: SpawnPlanInput,
): {
  readonly launch: TerminalLaunch | undefined;
  readonly plan: ManagedLaunchPlan | undefined;
} => {
  const plan = planManagedSpawn(input);
  if (!plan) {
    return { launch: input.documentLaunch, plan: undefined };
  }
  // Unconnected: keep document argv (may already be clean harness defaults).
  if (!plan.injection.inject) {
    return {
      launch: input.documentLaunch ?? plan.launch,
      plan,
    };
  }
  // Connected: use planned argv (Tier A flags applied).
  return { launch: plan.launch, plan };
};

export const harnessFromNode = (node: CanvasNode | undefined): string | undefined => {
  const h = node?.ether?.terminal?.harness?.trim();
  return h && h.length > 0 ? h : undefined;
};
