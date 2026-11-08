/**
 * The canvas as this machine holds it (`CanvasPlacement`): which machine edits
 * it, where each seat and automation lives and what each node is called. The
 * exchange judges rows by it; the ruling recorder writes the notices this
 * machine owes by it.
 */
import { Effect, Option } from "effect";
import type { ActorSeatId } from "@shared/actor-seat";
import type { InstallationId } from "@shared/installation-id";
import { titleOf } from "@shared/model/title";
import type { Node } from "@shared/model";
import type { CanvasPlacement } from "@shared/work-exchange";
import { deriveActorSeatId } from "../actor-seat-id";
import { AutomationRepository } from "../automation/repository";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";

type Home = { readonly seatId: ActorSeatId; readonly machine: InstallationId };

/** The installation behind a machine name, as this machine knows it now. */
export const machineInstallations = Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const byName = new Map<string, InstallationId>();
  for (const peer of yield* machines.peers) byName.set(peer.machineName, peer.installationId);
  byName.set(yield* machines.machineName, yield* machines.installationId);
  return byName;
});

/** Where each seat of a canvas lives: this machine's seats, and the peers of a copy. */
const homesOf = (nodes: ReadonlyArray<Node>, byName: ReadonlyMap<string, InstallationId>) => {
  const homes = new Map<string, Home>();
  for (const node of nodes) {
    if (node.kind !== "agent" && node.kind !== "peer") continue;
    const machine = byName.get(node.host);
    if (machine === undefined) continue;
    homes.set(node.id, {
      machine,
      seatId: node.kind === "peer" ? node.seatId : deriveActorSeatId(machine, node.bindingId),
    });
  }
  return homes;
};

const automationKey = (nodeId: string, automationId: string): string => JSON.stringify([nodeId, automationId]);

/**
 * Where each live automation of a canvas runs, by node and id, from the
 * rulings this machine folded: the machine it names, or the editing machine
 * for one that names none. One whose machine this machine does not know is
 * left out, and its rows are no one's.
 */
export const automationHomesOf = (canvasName: string, editor: InstallationId, byName: ReadonlyMap<string, InstallationId>) =>
  Effect.gen(function* () {
    const homes = new Map<string, InstallationId>();
    const repository = yield* Effect.serviceOption(AutomationRepository);
    if (Option.isNone(repository)) return homes;
    const state = yield* repository.value.loadState(canvasName);
    for (const { automation, archived } of state.values()) {
      if (archived) continue;
      const machine = automation.machine === undefined ? editor : byName.get(automation.machine);
      if (machine !== undefined) homes.set(automationKey(automation.nodeId, automation.automationId), machine);
    }
    return homes;
  });

export const canvasPlacement = (canvasName: string) =>
  Effect.gen(function* () {
    const records = yield* ModelRecords;
    const header = yield* records.getCanvas(canvasName);
    if (header === undefined) return undefined;
    const self = yield* (yield* MachineRepository).installationId;
    const editor = ((yield* records.canvasEditor(canvasName)) ?? self) as InstallationId;
    const listed = (yield* records.canvasAuthorities(canvasName)).map((id) => id as InstallationId);
    const authorities = listed.length === 0 ? [editor] : listed;
    const nodes = yield* records.listNodes(canvasName);
    const byName = yield* machineInstallations;
    const homes = homesOf(nodes, byName);
    const automations = yield* automationHomesOf(canvasName, editor, byName);
    const names = new Map(nodes.map((node) => [node.id as string, titleOf(node)]));
    const holders = new Set<InstallationId>([
      editor,
      ...authorities,
      ...[...homes.values()].map((home) => home.machine),
      ...automations.values(),
    ]);
    return {
      canvasId: header.canvas_id,
      editor,
      authorities,
      holds: (machine) => holders.has(machine),
      seatOf: (nodeId) => homes.get(nodeId),
      nameOf: (nodeId) => names.get(nodeId),
      automationOf: (nodeId, automationId) => automations.get(automationKey(nodeId, automationId)),
    } satisfies CanvasPlacement;
  });

