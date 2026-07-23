import type { CanvasDoc } from "@shared/canvas";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import {
  BROWSER_CAPABILITY_ACTIONS,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityGrant,
  type BrowserCapabilityRegistry,
  type BrowserCapabilityTarget,
} from "./capabilities";
import { resolveBrowserCallerFromProcess } from "./process-bind";
import type { PageTargetResolver } from "./page-target";
import {
  admitProcessIdentity,
  getProcessIdentityMap,
  type PeerPidReader,
  type ProcessIdentityMap,
  type ProcessPrincipal,
  readUnixPeerPid,
} from "../process-identity";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Either } from "effect";
import { decodeCanvasDoc } from "@shared/canvas";

// Edge-grant admission for process-bound callers:
//   peer PID → registered principal → canvas agent|herdr node → edges → pages
//   mint a short-lived capability under the hood so existing handlers keep
//   their lease model. Agents never present nodeRef or capability secrets.

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
  | "peer_pid_unavailable"
  | "process_unbound"
  | "not_found"
  | "ambiguous"
  | "not_connected"
  | "canvas_unreadable"
  | "capacity"
  | "closed";

export type EdgeGrantResult =
  | {
      readonly ok: true;
      readonly secret: string;
      readonly principal: ProcessPrincipal;
      readonly targetCount: number;
    }
  | { readonly ok: false; readonly denial: EdgeGrantDenial; readonly message: string };

export interface EdgeGrantService {
  readonly processMap: ProcessIdentityMap;
  /** Admit from a connected control socket (product path). */
  readonly admitSocket: (socket: Socket) => Promise<EdgeGrantResult>;
  /** Admit from an already-resolved principal (tests / internal). */
  readonly admitPrincipal: (principal: ProcessPrincipal) => Promise<EdgeGrantResult>;
  readonly clear: () => void;
  readonly invalidateCanvas?: (canvasName: string) => void;
}

interface CacheEntry {
  readonly secret: string;
  readonly principal: BrowserAutomationPrincipal;
  readonly handle: BrowserCapabilityGrant["handle"];
  readonly processKey: string;
  readonly targetSignature: string;
  readonly canvasName: string;
  readonly expiresAt: number;
}

export interface EdgeGrantDependencies {
  readonly capabilities: BrowserCapabilityRegistry;
  readonly canvasesDir: string;
  readonly resolvePageTarget: PageTargetResolver;
  readonly processMap?: ProcessIdentityMap;
  readonly readPeerPid?: PeerPidReader;
  readonly wallNow?: () => number;
  readonly ttlMs?: number;
  /** Optional single-doc loader override for tests. */
  readonly readCanvas?: (name: string) => Promise<CanvasDoc | undefined>;
}

const fail = (denial: EdgeGrantDenial, message: string): EdgeGrantResult => ({
  ok: false,
  denial,
  message,
});

const processKeyOf = (principal: ProcessPrincipal): string => {
  if (principal.kind === "agent") {
    return `agent:${principal.agentKey ?? ""}:${principal.canvasName ?? ""}:${principal.nodeId ?? ""}`;
  }
  return `herdr:${principal.paneId ?? ""}:${principal.canvasName ?? ""}:${principal.nodeId ?? ""}`;
};

const sameTargetSignature = (
  cached: string,
  targets: ReadonlyArray<BrowserCapabilityTarget>,
): boolean => cached === makeTargetSignature(targets);

const makeTargetSignature = (targets: ReadonlyArray<BrowserCapabilityTarget>): string => {
  const stable = targets
    .map((target) =>
      JSON.stringify({
        ref: target.ref,
        profile: target.profile,
        exactOrigins: [...target.exactOrigins].sort(),
      }),
    )
    .sort();
  return createHash("sha256")
    .update(stable.join("|"))
    .digest("base64url");
};

export const makeEdgeGrantService = (
  dependencies: EdgeGrantDependencies,
): EdgeGrantService => {
  const processMap = dependencies.processMap ?? getProcessIdentityMap();
  const readPeerPid = dependencies.readPeerPid ?? readUnixPeerPid;
  const wallNow = dependencies.wallNow ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? EDGE_GRANT_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const cacheByCanvas = new Map<string, Set<string>>();
  const capabilityPrincipals = new Map<string, BrowserAutomationPrincipal>();

  const removeCacheIndex = (canvasName: string, cacheKey: string): void => {
    const keys = cacheByCanvas.get(canvasName);
    if (keys === undefined) return;
    keys.delete(cacheKey);
    if (keys.size === 0) cacheByCanvas.delete(canvasName);
  };

  const revokeCacheEntry = (cacheKey: string): void => {
    const existing = cache.get(cacheKey);
    if (existing === undefined) return;
    cache.delete(cacheKey);
    removeCacheIndex(existing.canvasName, cacheKey);
    try {
      dependencies.capabilities.revoke(existing.handle, "superseded");
    } catch {
      // best-effort
    }
  };

  const invalidateCanvas = (canvasName: string): void => {
    const affected = cacheByCanvas.get(canvasName);
    if (affected === undefined) return;
    for (const cacheKey of [...affected]) {
      revokeCacheEntry(cacheKey);
    }
  };

  const loadDocs = async (): Promise<ReadonlyArray<{ name: string; doc: CanvasDoc }>> => {
    if (dependencies.readCanvas !== undefined) {
      // Test path: try common names via override by scanning dir when possible.
      try {
        const names = (await readdir(dependencies.canvasesDir)).filter((n) =>
          n.endsWith(".canvas"),
        );
        const out: Array<{ name: string; doc: CanvasDoc }> = [];
        for (const file of names.sort()) {
          const name = file.slice(0, -".canvas".length);
          const doc = await dependencies.readCanvas(name);
          if (doc) out.push({ name, doc });
        }
        if (out.length > 0) return out;
      } catch {
        // fall through
      }
      return [];
    }
    try {
      const names = (await readdir(dependencies.canvasesDir)).filter((n) =>
        n.endsWith(".canvas"),
      );
      const out: Array<{ name: string; doc: CanvasDoc }> = [];
      for (const file of names.sort()) {
        try {
          const raw = await readFile(join(dependencies.canvasesDir, file), "utf8");
          const decoded = decodeCanvasDoc(JSON.parse(raw));
          if (Either.isRight(decoded)) {
            out.push({ name: file.slice(0, -".canvas".length), doc: decoded.right });
          }
        } catch {
          // skip
        }
      }
      return out;
    } catch {
      return [];
    }
  };

  const buildTargets = async (
    pageRefs: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<BrowserCapabilityTarget>> => {
    const targets: BrowserCapabilityTarget[] = [];
    for (const ref of pageRefs) {
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

  const admitPrincipal = async (
    principal: ProcessPrincipal,
  ): Promise<EdgeGrantResult> => {
    const docs = await loadDocs();
    if (docs.length === 0) {
      return fail("canvas_unreadable", "no canvases available for process-bind resolution");
    }

    const matches: Array<{ canvasName: string; pageRefs: ReadonlyArray<string> }> = [];

    let lastDenial: EdgeGrantDenial = "not_found";
    let lastMessage = "no matching agent|herdr node for connecting process";

    for (const { name, doc } of docs) {
      const resolved = resolveBrowserCallerFromProcess(doc, name, principal);
      if (!resolved.ok) {
        lastDenial =
          resolved.denial === "not_connected"
            ? "not_connected"
            : resolved.denial === "ambiguous"
              ? "ambiguous"
              : "not_found";
        lastMessage = resolved.message;
        continue;
      }
      matches.push({ canvasName: resolved.principal.canvasName, pageRefs: resolved.pageRefs });
    }

    if (matches.length === 0) {
      return fail(lastDenial, lastMessage);
    }
    if (matches.length > 1) {
      return fail(
        "ambiguous",
        "connecting process matches multiple canvas nodes — keep one agent|herdr card per process",
      );
    }

    const match = matches[0]!;
    const targets = await buildTargets(match.pageRefs);
    if (targets.length === 0) {
      return fail(
        "not_connected",
        "missing edge between caller and a page node — draw an edge in Vellum",
      );
    }

    const cacheKey = processKeyOf(principal);
    const now = wallNow();
    const existing = cache.get(cacheKey);
    if (existing !== undefined) {
      if (
        existing.expiresAt > now + 5_000 &&
        sameTargetSignature(existing.targetSignature, targets)
      ) {
        return {
          ok: true,
          secret: existing.secret,
          principal,
          targetCount: targets.length,
        };
      }
      revokeCacheEntry(cacheKey);
    }

    let capPrincipal = capabilityPrincipals.get(cacheKey);
    if (capPrincipal === undefined) {
      try {
        capPrincipal = dependencies.capabilities.createPrincipal();
        capabilityPrincipals.set(cacheKey, capPrincipal);
      } catch {
        return fail("closed", "browser authority is closed");
      }
    }

    let grant: BrowserCapabilityGrant;
    try {
      grant = dependencies.capabilities.issue(capPrincipal, {
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
      principal: capPrincipal,
      handle: grant.handle,
      processKey: cacheKey,
      targetSignature: makeTargetSignature(targets),
      canvasName: match.canvasName,
      expiresAt: grant.expiresAt,
    });
    const keys = cacheByCanvas.get(match.canvasName);
    if (keys === undefined) {
      cacheByCanvas.set(match.canvasName, new Set([cacheKey]));
    } else {
      keys.add(cacheKey);
    }

    return {
      ok: true,
      secret: grant.secret,
      principal,
      targetCount: targets.length,
    };
  };

  const admitSocket = async (socket: Socket): Promise<EdgeGrantResult> => {
    const identity = admitProcessIdentity(socket, processMap, readPeerPid);
    if (!identity.ok) {
      return fail(
        identity.denial === "peer_pid_unavailable"
          ? "peer_pid_unavailable"
          : "process_unbound",
        identity.message,
      );
    }
    return admitPrincipal(identity.principal);
  };

  return Object.freeze({
    processMap,
    admitSocket,
    admitPrincipal,
    clear: () => {
      const entries = [...cache.keys()];
      for (const cacheKey of entries) {
        revokeCacheEntry(cacheKey);
      }
      cache.clear();
      cacheByCanvas.clear();
      capabilityPrincipals.clear();
    },
    invalidateCanvas,
  });
};
