import { sign, verify, type KeyObject } from "node:crypto";
import type { Socket } from "node:net";
import type { CanvasDoc } from "@shared/canvas";
import { canonicalStationBrowserJson, decodeStationBrowserEnvelope, isStationBrowserKeyId, STATION_BROWSER_CLOCK_SKEW_MS, STATION_BROWSER_MAX_TTL_MS, type StationBrowserDenial, type StationBrowserEnvelope, type StationBrowserRequest } from "@shared/station-browser";
import { formatNodeRef, parseNodeRef } from "@shared/node-ref";
import { resolveNodeHostId } from "@shared/station";
import {
  admitProcessIdentity,
  getProcessIdentityMap,
  readUnixPeerPid,
  type PeerPidReader,
  type ProcessIdentityMap,
  type ProcessPrincipal,
} from "../process-identity";
import { findNode } from "./authz";
import { resolveBrowserCallerFromProcess } from "./process-bind";

declare const witnessBrand: unique symbol;
export interface AdmittedDelegationWitness { readonly [witnessBrand]: never }
export interface StationBrowserDelegationTarget {
  readonly targetStationId: string;
  readonly pageRef?: string;
}
export interface StationBrowserRouteAdmission {
  /**
   * Optional pre-body process-bind gate for owner-local HTTP hosting. The
   * target-specific admit call still re-resolves every fact after routing.
   */
  readonly preflight: (signal?: AbortSignal) => Promise<void>;
  readonly admit: (
    target: StationBrowserDelegationTarget,
    signal?: AbortSignal,
  ) => Promise<AdmittedDelegationWitness>;
}
type WitnessData = Readonly<{
  kind: "agent-edge" | "operator-ui";
  stationId: string;
  agentRef?: string;
  target?: StationBrowserDelegationTarget;
}>;
const witnesses = new WeakMap<object, WitnessData>();

export type StationBrowserOriginAdmissionDenial =
  | "cancelled"
  | "peer_pid_unavailable"
  | "process_unbound"
  | "caller_wrong_kind"
  | "canvas_unreadable"
  | "not_found"
  | "ambiguous"
  | "not_connected"
  | "wrong_host";

export class StationBrowserOriginAdmissionError extends Error {
  constructor(
    readonly denial: StationBrowserOriginAdmissionDenial,
    message: string,
  ) {
    super(message);
    this.name = "StationBrowserOriginAdmissionError";
  }
}

export interface AgentStationBrowserRouteAdmissionOptions {
  readonly stationId: string;
  readonly socket: Socket;
  readonly readCanvas: (name: string) => Promise<CanvasDoc | undefined>;
  readonly processMap?: ProcessIdentityMap;
  readonly readPeerPid?: PeerPidReader;
}

const canonicalStationId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

const mintWitness = (data: WitnessData): AdmittedDelegationWitness => {
  const witness = Object.freeze({}) as AdmittedDelegationWitness;
  witnesses.set(witness, Object.freeze(data));
  return witness;
};

/**
 * Per-socket Command Center admission. Each call re-resolves peer PID, live
 * agent seat, current canvas, direct browser.automate edge, and the router's
 * already-derived target. It deliberately does not mint a local browser
 * capability: the connected page may live on a different physical station.
 */
export const makeAgentStationBrowserRouteAdmission = (
  options: AgentStationBrowserRouteAdmissionOptions,
): StationBrowserRouteAdmission => {
  if (
    !canonicalStationId(options.stationId) ||
    typeof options.readCanvas !== "function"
  ) {
    throw new StationBrowserOriginAdmissionError(
      "wrong_host",
      "station browser origin admission is not configured",
    );
  }

  type CanvasPinnedAgent = ProcessPrincipal & Readonly<{
    kind: "agent";
    canvasName: string;
    nodeId: string;
  }>;
  const resolveAgentIdentity = (
    signal?: AbortSignal,
  ): CanvasPinnedAgent => {
    if (signal?.aborted) {
      throw new StationBrowserOriginAdmissionError(
        "cancelled",
        "station browser origin admission was cancelled",
      );
    }
    const identity = admitProcessIdentity(
      options.socket,
      options.processMap ?? getProcessIdentityMap(),
      options.readPeerPid ?? readUnixPeerPid,
    );
    if (!identity.ok) {
      throw new StationBrowserOriginAdmissionError(
        identity.denial === "peer_pid_unavailable"
          ? "peer_pid_unavailable"
          : "process_unbound",
        identity.message,
      );
    }
    const principal = identity.principal;
    if (
      principal.canvasName === undefined ||
      principal.nodeId === undefined
    ) {
      throw new StationBrowserOriginAdmissionError(
        "caller_wrong_kind",
        "station browser delegation requires a canvas-pinned live agent",
      );
    }
    return principal as CanvasPinnedAgent;
  };

  return Object.freeze({
    preflight: async (signal?: AbortSignal): Promise<void> => {
      resolveAgentIdentity(signal);
    },
    admit: async (
      target: StationBrowserDelegationTarget,
      signal?: AbortSignal,
    ): Promise<AdmittedDelegationWitness> => {
      if (
        !canonicalStationId(target.targetStationId) ||
        (target.pageRef !== undefined && !parseNodeRef(target.pageRef).ok)
      ) {
        throw new StationBrowserOriginAdmissionError(
          "wrong_host",
          "station browser target is not canonical",
        );
      }

      const principal = resolveAgentIdentity(signal);

      let doc: CanvasDoc | undefined;
      try {
        doc = await options.readCanvas(principal.canvasName);
      } catch {
        doc = undefined;
      }
      if (signal?.aborted) {
        throw new StationBrowserOriginAdmissionError(
          "cancelled",
          "station browser origin admission was cancelled",
        );
      }
      if (doc === undefined) {
        throw new StationBrowserOriginAdmissionError(
          "canvas_unreadable",
          "station browser origin canvas is unavailable",
        );
      }

      // Origin station is Command Center for this route — name it so placement
      // classifies the CC actor correctly (I18 CC↔Station, not Station↔Station).
      const resolved = resolveBrowserCallerFromProcess(
        doc,
        principal.canvasName,
        principal,
        { topology: { commandCenterHostId: options.stationId } },
      );
      if (!resolved.ok) {
        throw new StationBrowserOriginAdmissionError(
          resolved.ok ? "caller_wrong_kind" : resolved.denial,
          resolved.ok
            ? "station browser delegation requires an agent seat"
            : resolved.message,
        );
      }
      const caller = findNode(doc, resolved.principal.nodeId);
      if (
        caller === undefined ||
        resolveNodeHostId(caller) !== options.stationId
      ) {
        throw new StationBrowserOriginAdmissionError(
          "wrong_host",
          "agent seat is not hosted by this origin station",
        );
      }

      const connectedOnTarget = resolved.pageRefs.some((ref) => {
        if (target.pageRef !== undefined && ref !== target.pageRef) return false;
        const parsed = parseNodeRef(ref);
        if (
          !parsed.ok ||
          parsed.value.canvasName !== principal.canvasName
        ) {
          return false;
        }
        const page = findNode(doc!, parsed.value.nodeId);
        return page !== undefined &&
          resolveNodeHostId(page) === target.targetStationId;
      });
      if (!connectedOnTarget) {
        throw new StationBrowserOriginAdmissionError(
          "not_connected",
          "agent lacks a direct browser.automate edge to the target page",
        );
      }

      return mintWitness({
        kind: "agent-edge",
        stationId: options.stationId,
        agentRef: formatNodeRef({
          canvasName: principal.canvasName,
          nodeId: principal.nodeId,
        }),
        target: Object.freeze({ ...target }),
      });
    },
  });
};

/** Main-process UI admission seam. It accepts no client principal. */
export const makeOperatorStationBrowserRouteAdmission = (
  stationId: string,
): StationBrowserRouteAdmission => {
  if (!canonicalStationId(stationId)) {
    throw new Error("main admission requires a canonical station reference");
  }
  return Object.freeze({
    preflight: async (): Promise<void> => undefined,
    admit: async (
      target: StationBrowserDelegationTarget,
    ): Promise<AdmittedDelegationWitness> =>
      mintWitness({
        kind: "operator-ui",
        stationId,
        target: Object.freeze({ ...target }),
      }),
  });
};

/** Direct main-owned UI witness retained for transport-free protocol tests. */
export const admitOperatorUiDelegation = (
  stationId: string,
  target?: StationBrowserDelegationTarget,
): AdmittedDelegationWitness => {
  if (!canonicalStationId(stationId)) {
    throw new Error("main admission requires a canonical station reference");
  }
  return mintWitness({
    kind: "operator-ui",
    stationId,
    ...(target === undefined
      ? {}
      : { target: Object.freeze({ ...target }) }),
  });
};
export interface StationBrowserTrust { readonly keyId: string; readonly publicKey: KeyObject; readonly originStationId: string }
export interface StationBrowserVerificationContext { readonly stationId: string; readonly now: number; readonly role: "remote"; readonly browserReady: boolean; readonly resolvePage: (pageRef: string) => Readonly<{ hostId: string; edgeAllowed: boolean; policyAllowed: boolean }> | undefined; readonly currentGeneration: (request: StationBrowserRequest) => string | undefined; readonly allowAction: (request: StationBrowserRequest) => boolean }
export class StationBrowserReplayCache { private readonly values = new Map<string, number>(); constructor(private readonly capacity = 1024) {} consume(key: string, acceptedUntil: number, now: number): "ok" | "replayed" | "capacity" { for (const [k, expiry] of this.values) if (expiry < now) this.values.delete(k); if (this.values.has(key)) return "replayed"; if (this.values.size >= this.capacity) return "capacity"; this.values.set(key, acceptedUntil); return "ok"; } }
const signed = (request: StationBrowserRequest) => Buffer.from(canonicalStationBrowserJson(Object.fromEntries(Object.entries(request).filter(([, value]) => value !== null))));
export const bindStationBrowserRequest = (
  witness: AdmittedDelegationWitness,
  request: Omit<StationBrowserRequest, "authority" | "originStationId" | "agentRef">,
): StationBrowserRequest => {
  const data = witnesses.get(witness);
  if (data === undefined) {
    throw new Error("station browser delegation requires a main-admitted witness");
  }
  if (
    data.target !== undefined &&
    (
      data.target.targetStationId !== request.targetStationId ||
      data.target.pageRef !== request.pageRef
    )
  ) {
    throw new Error("station browser delegation witness does not match its admitted target");
  }
  return {
    ...request,
    authority: data.kind,
    originStationId: data.stationId,
    agentRef: data.agentRef ?? null,
    pageRef: request.pageRef ?? null,
    session: request.session ?? null,
    payload: request.payload ?? null,
  } as unknown as StationBrowserRequest;
};
export const mintStationBrowserEnvelope = (witness: AdmittedDelegationWitness, request: Omit<StationBrowserRequest, "authority" | "originStationId" | "agentRef">, keyId: string, privateKey: KeyObject): StationBrowserEnvelope => { if (!isStationBrowserKeyId(keyId) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("station browser delegation requires an Ed25519 private key and canonical key id"); const bound = bindStationBrowserRequest(witness, request); return { request: bound, keyId, signature: sign(null, signed(bound), privateKey).toString("base64url") }; };
export const verifyStationBrowserEnvelope = (frame: string, trust: StationBrowserTrust, context: StationBrowserVerificationContext, replays: StationBrowserReplayCache): { readonly ok: true; readonly request: StationBrowserRequest } | { readonly ok: false; readonly denial: StationBrowserDenial } => { const decoded = decodeStationBrowserEnvelope(frame); if (typeof decoded === "string") return { ok: false, denial: decoded }; if (trust.publicKey.asymmetricKeyType !== "ed25519") return { ok: false, denial: "algorithm" }; if (decoded.keyId !== trust.keyId) return { ok: false, denial: "key" }; const r = decoded.request; if (context.role !== "remote" || !context.browserReady || r.originStationId !== trust.originStationId || r.targetStationId !== context.stationId || (r.session !== undefined && r.session.hostId !== context.stationId)) return { ok: false, denial: "wrong_host" }; if (r.expiresAt <= r.issuedAt || r.expiresAt - r.issuedAt > STATION_BROWSER_MAX_TTL_MS) return { ok: false, denial: "ttl" }; if (r.issuedAt > context.now + STATION_BROWSER_CLOCK_SKEW_MS) return { ok: false, denial: "not_yet_valid" }; if (r.expiresAt < context.now - STATION_BROWSER_CLOCK_SKEW_MS) return { ok: false, denial: "expired" }; if (!verify(null, signed(r), trust.publicKey, Buffer.from(decoded.signature, "base64url"))) return { ok: false, denial: "signature" }; if (!context.allowAction(r)) return { ok: false, denial: "forbidden" }; if (r.pageRef !== undefined) { const page = context.resolvePage(r.pageRef); if (page === undefined || page.hostId !== context.stationId) return { ok: false, denial: "stale_canvas" }; if (!page.edgeAllowed || !page.policyAllowed) return { ok: false, denial: "forbidden" }; } if (r.session !== undefined && context.currentGeneration(r) !== r.session.generation) return { ok: false, denial: "stale_generation" }; const replay = replays.consume(`${r.originStationId}:${r.nonce}`, r.expiresAt + STATION_BROWSER_CLOCK_SKEW_MS, context.now); return replay === "ok" ? { ok: true, request: r } : { ok: false, denial: replay }; };
