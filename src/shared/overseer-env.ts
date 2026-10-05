import type {
  CanvasNode,
  EnvSource,
  EtherRegionEnvironment,
} from "./canvas";
import type { OverseerArgsFor, OverseerEnvSourceDraft } from "./overseer-control";
import type { RegionEnvironmentReport } from "./region-environment";

/**
 * Region environment authoring, the pure half.
 *
 * Every `env.*` mutation is a read-modify-write of `ether.region.environment`
 * on one group node. These functions build the next node and say why an edit
 * is refused; the overseer canvas path commits the result under the same
 * transaction, grant and revision rules as `node.configure`.
 *
 * The document holds names and references only. Nothing here reads a store,
 * resolves a reference, or sees a secret value.
 */

export type OverseerEnvEdit =
  | { readonly operation: "env.source-add"; readonly args: OverseerArgsFor<"env.source-add"> }
  | { readonly operation: "env.source-edit"; readonly args: OverseerArgsFor<"env.source-edit"> }
  | { readonly operation: "env.source-remove"; readonly args: OverseerArgsFor<"env.source-remove"> }
  | { readonly operation: "env.source-reorder"; readonly args: OverseerArgsFor<"env.source-reorder"> }
  | { readonly operation: "env.seal"; readonly args: OverseerArgsFor<"env.seal"> }
  | { readonly operation: "env.folders"; readonly args: OverseerArgsFor<"env.folders"> };

export type OverseerEnvRefusal = {
  readonly type: "InvalidArguments" | "NotFound";
  readonly message: string;
};

type Edited<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: OverseerEnvRefusal };

const refuse = (
  type: OverseerEnvRefusal["type"],
  message: string,
): { readonly ok: false; readonly error: OverseerEnvRefusal } => ({
  ok: false,
  error: { type, message },
});

/** A region is a group node. Anything else carries no environment. */
export const isRegionNode = (
  node: CanvasNode,
): node is Extract<CanvasNode, { type: "group" }> => node.type === "group";

export const notARegion = (nodeId: string): OverseerEnvRefusal => ({
  type: "InvalidArguments",
  message: `node "${nodeId}" is not a region; an environment belongs to a group node`,
});

/** The environment as stored. A region that never had one reads as empty. */
export const regionEnvironmentOf = (node: CanvasNode): EtherRegionEnvironment =>
  node.ether?.region?.environment ?? {};

/** A folder a seat can be given: absolute, or under the operator's home. */
const folderPathNamed = (folder: string): boolean =>
  folder.startsWith("/") || folder === "~" || folder.startsWith("~/");

const withId = (draft: OverseerEnvSourceDraft, id: string): EnvSource =>
  ({ ...draft, id }) as EnvSource;

const editSources = (
  sources: ReadonlyArray<EnvSource>,
  edit: Extract<OverseerEnvEdit, { operation: `env.source-${string}` }>,
  mintSourceId: () => string,
): Edited<ReadonlyArray<EnvSource>> => {
  const indexOf = (sourceId: string): number =>
    sources.findIndex((source) => source.id === sourceId);
  switch (edit.operation) {
    case "env.source-add": {
      const { source, index } = edit.args;
      const id = source.id ?? mintSourceId();
      if (indexOf(id) !== -1) {
        return refuse("InvalidArguments", `source "${id}" already exists in this region`);
      }
      if (index !== undefined && index > sources.length) {
        return refuse(
          "InvalidArguments",
          `index ${index} is past the end of the ${sources.length} sources in this region`,
        );
      }
      const at = index ?? sources.length;
      return {
        ok: true,
        value: [...sources.slice(0, at), withId(source, id), ...sources.slice(at)],
      };
    }
    case "env.source-edit": {
      const { sourceId, source } = edit.args;
      const at = indexOf(sourceId);
      if (at === -1) return refuse("NotFound", `source "${sourceId}" was not found`);
      if (source.id !== undefined && source.id !== sourceId) {
        return refuse(
          "InvalidArguments",
          `an edit keeps the source id: "${sourceId}" cannot become "${source.id}"`,
        );
      }
      return {
        ok: true,
        value: sources.map((existing, position) =>
          position === at ? withId(source, sourceId) : existing,
        ),
      };
    }
    case "env.source-remove": {
      const { sourceId } = edit.args;
      if (indexOf(sourceId) === -1) {
        return refuse("NotFound", `source "${sourceId}" was not found`);
      }
      return { ok: true, value: sources.filter((source) => source.id !== sourceId) };
    }
    case "env.source-reorder": {
      const { sourceIds } = edit.args;
      const byId = new Map(sources.map((source) => [source.id, source]));
      const permutation =
        sourceIds.length === sources.length &&
        new Set(sourceIds).size === sourceIds.length &&
        sourceIds.every((sourceId) => byId.has(sourceId));
      if (!permutation) {
        return refuse(
          "InvalidArguments",
          "sourceIds must name every source in this region exactly once",
        );
      }
      return { ok: true, value: sourceIds.map((sourceId) => byId.get(sourceId)!) };
    }
  }
};

const editEnvironment = (
  current: EtherRegionEnvironment,
  edit: OverseerEnvEdit,
  mintSourceId: () => string,
): Edited<EtherRegionEnvironment> => {
  switch (edit.operation) {
    case "env.seal":
      return { ok: true, value: { ...current, sealed: edit.args.sealed } };
    case "env.folders": {
      const unnamed = edit.args.folders.find((folder) => !folderPathNamed(folder));
      if (unnamed !== undefined) {
        return refuse(
          "InvalidArguments",
          `folder "${unnamed}" must be an absolute path or start with ~/`,
        );
      }
      return { ok: true, value: { ...current, folders: edit.args.folders } };
    }
    default: {
      const sources = editSources(current.sources ?? [], edit, mintSourceId);
      return sources.ok
        ? { ok: true, value: { ...current, sources: sources.value } }
        : sources;
    }
  }
};

/** Leave no empty husk behind: an unset switch or an empty list is absent. */
const compact = (
  environment: EtherRegionEnvironment,
): EtherRegionEnvironment | undefined => {
  const next: EtherRegionEnvironment = {
    ...(environment.sealed === true ? { sealed: true } : {}),
    ...(environment.sources !== undefined && environment.sources.length > 0
      ? { sources: environment.sources }
      : {}),
    ...(environment.folders !== undefined && environment.folders.length > 0
      ? { folders: environment.folders }
      : {}),
  };
  return Object.keys(next).length === 0 ? undefined : next;
};

/**
 * The node after one environment edit. Only `ether.region.environment` moves:
 * the region's hold, instruction, defaults and contract are carried as they
 * are, and so is everything else on the node.
 */
export const applyRegionEnvironmentEdit = (
  node: CanvasNode,
  edit: OverseerEnvEdit,
  mintSourceId: () => string,
): Edited<CanvasNode> => {
  if (!isRegionNode(node)) return { ok: false, error: notARegion(node.id) };
  const edited = editEnvironment(regionEnvironmentOf(node), edit, mintSourceId);
  if (!edited.ok) return edited;
  const environment = compact(edited.value);
  const { environment: _previous, ...region } = node.ether?.region ?? {};
  return {
    ok: true,
    value: {
      ...node,
      ether: {
        ...(node.ether ?? {}),
        region: environment === undefined ? region : { ...region, environment },
      },
    },
  };
};

/**
 * The canvas-wide report narrowed to one node. For a region: that region and
 * the seats it is in scope for. For a seat: that seat and the regions in its
 * scope. Rows are the resolver's, passed through untouched.
 */
export const narrowEnvironmentReport = (
  report: RegionEnvironmentReport,
  nodeId: string,
): RegionEnvironmentReport => {
  const seat = report.seats.find((entry) => entry.nodeId === nodeId);
  if (seat !== undefined) {
    return {
      regions: report.regions.filter((region) => seat.regions.includes(region.regionId)),
      seats: [seat],
    };
  }
  return {
    regions: report.regions.filter((region) => region.regionId === nodeId),
    seats: report.seats.filter((entry) => entry.regions.includes(nodeId)),
  };
};
