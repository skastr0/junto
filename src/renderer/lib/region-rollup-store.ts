import { batch, observable, observe } from "@legendapp/state";
import type { ActorRef } from "@shared/work-protocol";
import type { Task } from "@shared/work-model";
import type { Node, Wire } from "@shared/model";
import { asCanvasName } from "@shared/model";
import { regionMembers } from "@shared/model/canvas";
import { titleOf } from "@shared/model/title";
import { actorRefResolverFromProjection } from "@shared/graph";
import { deriveRegionRollups, type AgentActivity, type RegionRollup } from "@shared/region-rollup";
import type { WorkSurfaceActivity } from "@shared/terminal";
import { keepUnchanged, type createModelStore } from "./model-store";

export type RegionRollupSources = {
  readonly model: ReturnType<typeof createModelStore>;
  readonly actorRefs: () => ReadonlyArray<ActorRef>;
  readonly items: (canvas: string, nodeId: string) => ReadonlyArray<Task>;
  readonly agentActivity: (agentKey: string) => AgentActivity;
  readonly surface: (bindingId: string) => WorkSurfaceActivity | undefined;
};

const sameIds = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string>): boolean =>
  a !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);

/** Membership follows geometry; each rollup follows only its own members and Work connections. */
export const createRegionRollupStore = (
  sources: RegionRollupSources,
  derive = deriveRegionRollups,
) => {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  function createEntry(canvasName: string) {
    const state = observable({
      regionIds: [] as ReadonlyArray<string>,
      byRegionId: {} as Record<string, RegionRollup | undefined>,
    });
    const membership = observable({
      members: {} as Record<string, string[] | undefined>,
      wires: {} as Record<string, string[] | undefined>,
    });
    const actors = observable<Record<string, ActorRef | undefined>>({});
    const regional = new Map<string, () => void>();
    let users = 0;
    let offInputs: (() => void) | undefined;
    const model = sources.model.canvas$(canvasName);

    const followRegion = (regionId: string) => observe(() => {
      const region$ = model.nodes[regionId];
      if (region$.kind.get() !== "region") return;
      // titleOf names its own fields. Track those, rather than movement,
      // paint order or the rest of the node's configuration.
      const readNode = (id: string): Node | undefined => {
        const node$ = model.nodes[id];
        const node = node$.peek();
        if (!node) return undefined;
        const fields = node$ as unknown as Record<string, { get(): unknown }>;
        titleOf(new Proxy(node, { get: (_target, key) => fields[String(key)].get() }));
        return node;
      };
      const region = readNode(regionId);
      if (region?.kind !== "region") return;
      const nodes = new Map([[region.id, region]] as Array<[Node["id"], Node]>);
      const wires = new Map<Wire["id"], Wire>();
      const agentActivity = new Map<string, AgentActivity>();
      const terminalStatusByNodeId = new Map<string, WorkSurfaceActivity>();
      const refs: ActorRef[] = [];
      for (const id of membership.members[regionId].get() ?? []) {
        const node = readNode(id);
        if (!node) continue;
        nodes.set(node.id, node);
        if (node.kind === "agent" || node.kind === "terminal") {
          const bindingId = (model.nodes[id] as unknown as { bindingId: { get(): string } }).bindingId.get();
          const surface = sources.surface(bindingId);
          if (surface) terminalStatusByNodeId.set(id, surface);
        }
        if (node.kind === "agent") {
          const agentKey = (model.nodes[id] as unknown as { agentKey: { get(): string } }).agentKey.get();
          agentActivity.set(agentKey, sources.agentActivity(agentKey));
          const actor = actors[id].get();
          if (actor) refs.push(actor);
        }
      }
      for (const id of membership.wires[regionId].get() ?? []) {
        model.wires[id].from.get(); model.wires[id].to.get();
        const wire = model.wires[id].peek();
        if (!wire) continue;
        wires.set(wire.id, wire);
        for (const endpoint of [wire.from, wire.to]) {
          if (nodes.has(endpoint)) continue;
          // The peer's kind matters to stoppage; its name and location do not.
          model.nodes[endpoint].kind.get();
          const peer = model.nodes[endpoint].peek();
          if (peer) nodes.set(peer.id, peer);
        }
      }
      const rollup = derive({
        canvas: { name: asCanvasName(canvasName), seq: 0, nodes, wires },
        canvasName,
        resolveActorRef: actorRefResolverFromProjection(refs),
        itemsOf: (id) => sources.items(canvasName, id),
        agentActivity,
        terminalStatusByNodeId,
      })[0];
      const previous = state.byRegionId[regionId].peek();
      const next = keepUnchanged(previous, rollup);
      if (next !== previous) state.byRegionId[regionId].set(next);
    });

    const start = () => {
      const offActors = observe(() => {
        const refs = sources.actorRefs().filter((actor) => actor.canvasName === canvasName);
        const resolve = actorRefResolverFromProjection(refs);
        const ids = new Set([...Object.keys(actors.peek()), ...refs.map((actor) => actor.nodeId)]);
        batch(() => {
          for (const id of ids) {
            const previous = actors[id].peek();
            const next = keepUnchanged(previous, resolve({ canvasName, nodeId: id }));
            if (next !== previous) actors[id].set(next);
          }
        });
      });
      const offMembership = observe(() => {
        const ids = model.nodeIds.get();
        const nodes = new Map<Node["id"], Node>();
        for (const id of ids) {
          const node$ = model.nodes[id];
          node$.kind.get();
          node$.x.get(); node$.y.get(); node$.width.get(); node$.height.get();
          const node = node$.peek();
          if (node) nodes.set(node.id, node);
        }
        const canvas = { nodes };
        const regions = ids.filter((id) => nodes.get(id as Node["id"])?.kind === "region");
        const wires = model.wireIds.get().map((id) => {
          const wire$ = model.wires[id];
          wire$.from.get(); wire$.to.get();
          return wire$.peek();
        }).filter((wire): wire is Wire => wire !== undefined);
        batch(() => {
          for (const [id, off] of regional) {
            if (regions.includes(id)) continue;
            off(); regional.delete(id);
            state.byRegionId[id].delete();
            membership.members[id].delete(); membership.wires[id].delete();
          }
          for (const id of regions) {
            const region = nodes.get(id as Node["id"]);
            if (region?.kind !== "region") continue;
            const members = new Set(regionMembers(canvas, region).map((node) => node.id));
            const ordered = ids.filter((member) => members.has(member as Node["id"]));
            const agents = new Set(ordered.filter((member) => nodes.get(member as Node["id"])?.kind === "agent"));
            const relevantWires = wires.filter((wire) => {
              const from = nodes.get(wire.from), to = nodes.get(wire.to);
              return (agents.has(wire.from) && (to?.kind === "task" || to?.kind === "requests")) ||
                (agents.has(wire.to) && (from?.kind === "task" || from?.kind === "requests"));
            }).map((wire) => wire.id);
            if (!sameIds(membership.members[id].peek(), ordered)) membership.members[id].set(ordered);
            if (!sameIds(membership.wires[id].peek(), relevantWires)) membership.wires[id].set(relevantWires);
            if (!regional.has(id)) regional.set(id, followRegion(id));
          }
          if (!sameIds(state.regionIds.peek(), regions)) state.regionIds.set(regions);
        });
      });
      offInputs = () => {
        offMembership(); offActors();
        for (const off of regional.values()) off();
        regional.clear();
      };
    };
    return {
      state,
      retain: () => {
        if (++users === 1) start();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (--users === 0) { offInputs?.(); offInputs = undefined; }
        };
      },
    };
  }
  const entryFor = (canvas: string) => {
    let entry = entries.get(canvas);
    if (!entry) { entry = createEntry(canvas); entries.set(canvas, entry); }
    return entry;
  };
  return {
    state: (canvas: string) => entryFor(canvas).state,
    retain: (canvas: string) => entryFor(canvas).retain(),
  };
};
