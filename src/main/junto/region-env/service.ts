/**
 * Region environment — one implementation behind every surface.
 *
 * The seat launch, the region settings screen, the overseer doctor and a
 * seat's own `env.report` all read from here, so "inherited", "overridden"
 * and "sealed" mean the same thing wherever they are shown.
 *
 * Every dependency is injected: tests drive this with a fake resolver, a
 * document in memory and a fake set of running seats. `./live.ts` binds the
 * real ones.
 */
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { nodeDisplayLabel } from "@shared/board-actors";
import { isGroup, type RegionRect } from "@shared/graph";
import {
  changedNames,
  planRegionEnvironment,
  regionEnvironmentFingerprint,
  type RegionEnvironmentLaunchRecord,
  type RegionEnvironmentPlan,
  type RegionEnvironmentReport,
  type SeatEnvironmentReport,
  type SourceReport,
  type StaleSeat,
} from "@shared/region-environment";
import { resolveTerminalBinding } from "@shared/terminal";
import type {
  RegionEnvironmentResolution,
  ResolvedRegionEnvironment,
} from "./resolve";

export type RegionEnvironmentServiceDeps = {
  readonly resolution: RegionEnvironmentResolution;
  /** The canvas as saved right now. Undefined when it cannot be read. */
  readonly readDoc: (canvasName: string) => Promise<CanvasDoc | undefined>;
  /** This machine's host id, as a source's `host` would name it. */
  readonly hostId: () => Promise<string>;
  /**
   * What the generation running on a binding was launched with, or undefined
   * when nothing is running there.
   */
  readonly launchRecord: (
    bindingId: string,
  ) => RegionEnvironmentLaunchRecord | undefined;
};

/** A node that is an agent seat, with the binding its process runs on. */
const seatBinding = (node: CanvasNode): string | undefined => {
  if (isGroup(node)) return undefined;
  const binding = resolveTerminalBinding(node);
  return binding?.kind === "native" && binding.harness !== undefined
    ? binding.bindingId
    : undefined;
};

export const makeRegionEnvironmentService = (
  deps: RegionEnvironmentServiceDeps,
) => {
  /**
   * One read of the stores per distinct plan within a call. Seats that share
   * a region share a plan, so a canvas-wide report asks each store once per
   * region rather than once per seat.
   */
  const memoized = () => {
    const seen = new Map<string, Promise<ResolvedRegionEnvironment>>();
    return (
      doc: CanvasDoc,
      plan: RegionEnvironmentPlan,
      resolve: () => Promise<ResolvedRegionEnvironment>,
    ): Promise<ResolvedRegionEnvironment> => {
      void doc;
      const key = `${plan.regions.map((region) => region.regionId).join("/")}#${regionEnvironmentFingerprint(plan)}`;
      const hit = seen.get(key);
      if (hit) return hit;
      const made = resolve();
      seen.set(key, made);
      return made;
    };
  };

  /** Is the running generation on this seat on the current resolution? */
  const staleness = async (
    doc: CanvasDoc,
    node: CanvasNode,
    hostId: string,
  ): Promise<{ readonly stale: boolean; readonly changed: ReadonlyArray<string> }> => {
    const bindingId = seatBinding(node);
    const launched = bindingId ? deps.launchRecord(bindingId) : undefined;
    // A seat that is not running has nothing to restart.
    if (launched === undefined) return { stale: false, changed: [] };
    const plan = planRegionEnvironment(doc, { seat: node.id }, hostId);
    // Decided from the document alone: no store is read to ask the question.
    if (regionEnvironmentFingerprint(plan) === launched.fingerprint) {
      return { stale: false, changed: [] };
    }
    const current = await deps.resolution.current(doc, { seat: node.id }, hostId);
    return { stale: true, changed: changedNames(launched, current) };
  };

  const seatReport = async (
    doc: CanvasDoc,
    node: CanvasNode,
    hostId: string,
    resolveOnce: ReturnType<typeof memoized>,
  ): Promise<SeatEnvironmentReport> => {
    const plan = planRegionEnvironment(doc, { seat: node.id }, hostId);
    const resolved = await resolveOnce(doc, plan, () =>
      deps.resolution.resolve(doc, { seat: node.id }, hostId),
    );
    return {
      nodeId: node.id,
      title: nodeDisplayLabel(node),
      regions: plan.regions.map((region) => region.regionId),
      report: resolved.report,
      folders: plan.folders,
      restartToApply: (await staleness(doc, node, hostId)).stale,
    };
  };

  return {
    /**
     * For one launch. `seatRect` is where the seat sits when the caller holds
     * a node newer than the saved canvas. Total: an unreadable canvas is the
     * empty environment.
     */
    forLaunch: async (seat: {
      readonly canvasName: string;
      readonly nodeId: string;
      readonly seatRect?: RegionRect;
    }): Promise<ResolvedRegionEnvironment> => {
      const [doc, hostId] = await Promise.all([
        deps.readDoc(seat.canvasName),
        deps.hostId(),
      ]);
      return deps.resolution.resolve(
        doc ?? { nodes: [], edges: [] },
        { seat: seat.nodeId, ...(seat.seatRect ? { rect: seat.seatRect } : {}) },
        hostId,
      );
    },

    /** A region's resolution: a seat placed directly inside it. */
    regionReport: async (
      canvasName: string,
      regionId: string,
    ): Promise<ReadonlyArray<SourceReport> | undefined> => {
      const [doc, hostId] = await Promise.all([
        deps.readDoc(canvasName),
        deps.hostId(),
      ]);
      const region = doc?.nodes.find((node) => node.id === regionId);
      if (!doc || !region || !isGroup(region)) return undefined;
      return (await deps.resolution.resolve(doc, { region: regionId }, hostId))
        .report;
    },

    /** One seat's own resolution: what `env.report` returns. */
    seatReport: async (
      canvasName: string,
      nodeId: string,
    ): Promise<SeatEnvironmentReport | undefined> => {
      const [doc, hostId] = await Promise.all([
        deps.readDoc(canvasName),
        deps.hostId(),
      ]);
      const node = doc?.nodes.find((candidate) => candidate.id === nodeId);
      if (!doc || !node) return undefined;
      return seatReport(doc, node, hostId, memoized());
    },

    /**
     * The same, for a caller that already holds the canvas (the work socket
     * reads the caller's canvas before it dispatches any op).
     */
    seatReportFor: async (
      doc: CanvasDoc,
      nodeId: string,
    ): Promise<SeatEnvironmentReport | undefined> => {
      const node = doc.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return undefined;
      return seatReport(doc, node, await deps.hostId(), memoized());
    },

    /** Every region with an environment in scope, and every seat. */
    canvasReport: async (
      canvasName: string,
    ): Promise<RegionEnvironmentReport | undefined> => {
      const [doc, hostId] = await Promise.all([
        deps.readDoc(canvasName),
        deps.hostId(),
      ]);
      if (!doc) return undefined;
      const resolveOnce = memoized();
      const regions: RegionEnvironmentReport["regions"][number][] = [];
      for (const region of doc.nodes.filter(isGroup)) {
        const plan = planRegionEnvironment(doc, { region: region.id }, hostId);
        const own = plan.regions.find((entry) => entry.regionId === region.id);
        // A region with nothing of its own and nothing inherited says nothing.
        if (plan.sources.length === 0 && plan.folders.length === 0 && !own?.sealed) {
          continue;
        }
        const resolved = await resolveOnce(doc, plan, () =>
          deps.resolution.resolve(doc, { region: region.id }, hostId),
        );
        regions.push({
          regionId: region.id,
          regionLabel: own?.regionLabel ?? region.id,
          sealed: own?.sealed === true,
          sources: resolved.report,
        });
      }
      const seats: SeatEnvironmentReport[] = [];
      for (const node of doc.nodes) {
        if (seatBinding(node) === undefined) continue;
        seats.push(await seatReport(doc, node, hostId, resolveOnce));
      }
      return { regions, seats };
    },

    /**
     * Running seats inside a region (nested regions included) whose launch
     * environment differs from the current resolution.
     */
    staleSeats: async (
      canvasName: string,
      regionId: string,
    ): Promise<ReadonlyArray<StaleSeat> | undefined> => {
      const [doc, hostId] = await Promise.all([
        deps.readDoc(canvasName),
        deps.hostId(),
      ]);
      const region = doc?.nodes.find((node) => node.id === regionId);
      if (!doc || !region || !isGroup(region)) return undefined;
      const inside = (node: CanvasNode): boolean =>
        node.x >= region.x &&
        node.y >= region.y &&
        node.x + node.width <= region.x + region.width &&
        node.y + node.height <= region.y + region.height;
      const stale: StaleSeat[] = [];
      for (const node of doc.nodes) {
        if (seatBinding(node) === undefined || !inside(node)) continue;
        const verdict = await staleness(doc, node, hostId);
        if (!verdict.stale) continue;
        stale.push({
          seatId: node.id,
          title: nodeDisplayLabel(node),
          changed: verdict.changed,
        });
      }
      return stale;
    },
  };
};

export type RegionEnvironmentService = ReturnType<
  typeof makeRegionEnvironmentService
>;
