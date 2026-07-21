import type { CanvasDoc } from "@shared/canvas";
import { formatNodeRef, parseNodeRef } from "@shared/node-ref";
import {
  BROWSER_CAPABILITY_ACTIONS,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityGrant,
  type BrowserCapabilityRegistry,
  type BrowserCapabilityTarget,
} from "./capabilities";
import {
  connectedPageNodeIds,
  findNode,
  isPageNode,
  resolveBrowserCaller,
  type BrowserCallerPrincipal,
} from "./authz";
import type { PageTargetResolver } from "./page-target";
import {
  makeProcessBindMap,
  resolveProcessBoundCaller,
  type ProcessBindMap,
} from "./process-bind";

// Edge-grant admission: human-drawn agent|herdr → page edges mint a short-lived
// capability under the hood so existing control handlers keep their lease
// model. Agents never receive spawn-sibling ceremony — they present
// VELLUM_NODE_REF + the owner-local transport token.

export const EDGE_GRANT_TTL_MS = 15 * 60 * 1_000;
export const EDGE_GRANT_MAX_USES = 4_096;
export const EDGE_GRANT_MAX_IN_FLIGHT = 8;

const exactHttpOrigin = (value: string): string | undefined => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin !== "null"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
};

export type EdgeGrantDenial =
  | "invalid_node_ref"
  | "caller_missing"
  | "caller_wrong_kind"
  | "not_connected"
  | "canvas_unreadable"
  | "pid_mismatch"
  | "pid_unbound"
  | "capacity"
  | "closed";

export type EdgeGrantResult =
  | {
      readonly ok: true;
      readonly secret: string;
      readonly principal: BrowserCallerPrincipal;
      readonly targetCount: number;
    }
  | { readonly ok: false; readonly denial: EdgeGrantDenial; readonly message: string };

export interface EdgeGrantService {
  readonly processMap: ProcessBindMap;
  readonly admit: (
    nodeRef: string,
    options?: { readonly peerPid?: number; readonly requirePidBind?: boolean },
  ) => Promise<EdgeGrantResult>;
  readonly revokeCaller: (nodeRef: string) => void;
  readonly clear: () => void;
}

interface CacheEntry {
  readonly secret: string;
  readonly principal: BrowserAutomationPrincipal;
  readonly handle: BrowserCapabilityGrant["handle"];
  readonly caller: BrowserCallerPrincipal;
  readonly targetRefs: ReadonlyArray<string>;
  readonly expiresAt: number;
}

export interface EdgeGrantDependencies {
  readonly capabilities: BrowserCapabilityRegistry;
  readonly readCanvas: (name: string) => Promise<CanvasDoc | undefined>;
  readonly resolvePageTarget: PageTargetResolver;
  readonly processMap?: ProcessBindMap;
  readonly wallNow?: () => number;
  readonly ttlMs?: number;
}

const fail = (denial: EdgeGrantDenial, message: string): EdgeGrantResult => ({
  ok: false,
  denial,
  message,
});

const sameTargetRefs = (
  cached: ReadonlyArray<string>,
  targets: ReadonlyArray<BrowserCapabilityTarget>,
): boolean =>
  cached.length === targets.length &&
  cached.every((ref, index) => ref === targets[index]?.ref);

export const makeEdgeGrantService = (
  dependencies: EdgeGrantDependencies,
): EdgeGrantService => {
  const processMap = dependencies.processMap ?? makeProcessBindMap();
  const wallNow = dependencies.wallNow ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? EDGE_GRANT_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const principals = new Map<string, BrowserAutomationPrincipal>();

  const revokeCaller = (nodeRef: string): void => {
    const entry = cache.get(nodeRef);
    if (entry === undefined) return;
    cache.delete(nodeRef);
    try {
      dependencies.capabilities.revoke(entry.handle, "superseded");
    } catch {
      // Best-effort; admit will mint a fresh grant.
    }
  };

  const clear = (): void => {
    for (const key of [...cache.keys()]) revokeCaller(key);
    processMap.clear();
    principals.clear();
  };

  const buildTargets = async (
    doc: CanvasDoc,
    canvasName: string,
    callerId: string,
  ): Promise<ReadonlyArray<BrowserCapabilityTarget>> => {
    const targets: BrowserCapabilityTarget[] = [];
    for (const pageId of connectedPageNodeIds(doc, callerId)) {
      const node = findNode(doc, pageId);
      if (!isPageNode(node) || node === undefined || node.type !== "link") continue;
      let ref: string;
      try {
        ref = formatNodeRef({ canvasName, nodeId: pageId });
      } catch {
        continue;
      }
      const resolved = await dependencies.resolvePageTarget(ref);
      if (!resolved.ok || resolved.data.ref !== ref) continue;
      const origin = exactHttpOrigin(resolved.data.url);
      if (origin === undefined) continue;
      targets.push(
        Object.freeze({
          ref,
          profile: resolved.data.profile,
          exactOrigins: Object.freeze([origin]),
        }),
      );
    }
    return Object.freeze(
      [...targets].sort((a, b) => a.ref.localeCompare(b.ref)),
    );
  };

  const admit = async (
    nodeRef: string,
    options: { readonly peerPid?: number; readonly requirePidBind?: boolean } = {},
  ): Promise<EdgeGrantResult> => {
    const parsed = parseNodeRef(nodeRef);
    if (!parsed.ok) {
      return fail("invalid_node_ref", parsed.error.message);
    }

    let doc: CanvasDoc | undefined;
    try {
      doc = await dependencies.readCanvas(parsed.value.canvasName);
    } catch {
      return fail("canvas_unreadable", "canvas could not be read");
    }
    if (doc === undefined) {
      return fail("canvas_unreadable", "canvas not found");
    }

    const bound = resolveProcessBoundCaller(doc, nodeRef, {
      peerPid: options.peerPid,
      processMap,
      requirePidBind: options.requirePidBind,
    });
    if (!bound.ok) {
      const denial =
        bound.denial === "invalid_node_ref"
          ? "invalid_node_ref"
          : bound.denial === "pid_mismatch"
            ? "pid_mismatch"
            : bound.denial === "pid_unbound"
              ? "pid_unbound"
              : bound.denial === "caller_missing"
                ? "caller_missing"
                : "caller_wrong_kind";
      return fail(denial, bound.message);
    }

    // Re-check caller against live doc after bind (same result, keeps types tight).
    const caller = resolveBrowserCaller(
      doc,
      bound.principal.canvasName,
      bound.principal.nodeId,
    );
    if (!caller.ok) {
      return fail(
        caller.denial === "caller_missing" ? "caller_missing" : "caller_wrong_kind",
        "caller is not a live agent or herdr node",
      );
    }

    const targets = await buildTargets(
      doc,
      bound.principal.canvasName,
      bound.principal.nodeId,
    );
    if (targets.length === 0) {
      return fail(
        "not_connected",
        "missing edge between caller and a page node — draw an edge in Vellum",
      );
    }

    const cacheKey = nodeRef;
    const now = wallNow();
    const existing = cache.get(cacheKey);
    if (existing !== undefined) {
      if (
        existing.expiresAt > now + 5_000 &&
        sameTargetRefs(existing.targetRefs, targets)
      ) {
        return {
          ok: true,
          secret: existing.secret,
          principal: existing.caller,
          targetCount: targets.length,
        };
      }
      revokeCaller(cacheKey);
    }

    let principal = principals.get(cacheKey);
    if (principal === undefined) {
      try {
        principal = dependencies.capabilities.createPrincipal();
        principals.set(cacheKey, principal);
      } catch {
        return fail("closed", "browser authority is closed");
      }
    }

    let grant: BrowserCapabilityGrant;
    try {
      grant = dependencies.capabilities.issue(principal, {
        actions: [...BROWSER_CAPABILITY_ACTIONS],
        targets,
        ttlMs,
        maxUses: EDGE_GRANT_MAX_USES,
        maxInFlight: EDGE_GRANT_MAX_IN_FLIGHT,
      });
    } catch (error) {
      const reason =
        error instanceof Error && "reason" in error
          ? String((error as { reason: unknown }).reason)
          : "invalid";
      if (reason === "capacity") return fail("capacity", "browser authority capacity reached");
      if (reason === "closed") return fail("closed", "browser authority is closed");
      return fail("not_connected", "could not mint edge-scoped browser authority");
    }

    cache.set(cacheKey, {
      secret: grant.secret,
      principal,
      handle: grant.handle,
      caller: caller.principal,
      targetRefs: targets.map((t) => t.ref),
      expiresAt: grant.expiresAt,
    });

    return {
      ok: true,
      secret: grant.secret,
      principal: caller.principal,
      targetCount: targets.length,
    };
  };

  return Object.freeze({
    processMap,
    admit,
    revokeCaller,
    clear,
  });
};
