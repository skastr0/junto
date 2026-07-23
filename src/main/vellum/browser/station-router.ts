import { randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { Effect } from "effect";
import {
  BROWSER_HOST_CAPABILITY,
  hostHasCapability,
  type RemoteHost,
} from "@shared/remote-hosts";
import {
  decodeStationBrowserResponse,
  STATION_BROWSER_MAX_EVAL_BYTES,
  STATION_BROWSER_MAX_TTL_MS,
  type StationBrowserAction,
  type StationBrowserRequest,
  type StationBrowserResponse,
  type StationBrowserSession,
} from "@shared/station-browser";
import type { SshError, SshTransport } from "../ssh";
import {
  bindStationBrowserRequest,
  mintStationBrowserEnvelope,
  StationBrowserOriginAdmissionError,
  type StationBrowserRouteAdmission,
} from "./station-delegation";
import { parseNodeRef } from "@shared/node-ref";
import {
  dispatchStationBrowser,
  type StationBrowserTransportError,
} from "./station-transport";

export const STATION_BROWSER_ROUTE_TTL_MS = Math.min(
  30_000,
  STATION_BROWSER_MAX_TTL_MS,
);
export const STATION_BROWSER_MAX_REMOTE_CONCURRENCY = 6;
export const STATION_BROWSER_MAX_REMOTE_CONCURRENCY_PER_HOST = 2;

type NoTargetAction = Extract<StationBrowserAction, "doctor" | "discover" | "list">;
type SessionAction = Exclude<StationBrowserAction, NoTargetAction | "open">;

export type StationBrowserRouteInput =
  | Readonly<{
      action: NoTargetAction;
      targetHostId: string;
    }>
  | Readonly<{
      action: "open";
      pageRef: string;
      /** Optional assertion only. Document truth remains authoritative. */
      targetHostId?: string;
    }>
  | Readonly<{
      action: SessionAction;
      pageRef: string;
      session: StationBrowserSession;
      payload?: Readonly<Record<string, string>>;
      /** Optional assertion only. Document/session truth remains authoritative. */
      targetHostId?: string;
    }>;

export type StationBrowserRouteInputDecode =
  | Readonly<{ ok: true; input: StationBrowserRouteInput }>
  | Readonly<{ ok: false }>;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
};

const boundedText = (value: unknown, maxBytes = 4_096): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") > 0 &&
  Buffer.byteLength(value, "utf8") <= maxBytes &&
  !/[\u0000-\u001f\u007f]/.test(value);

const routeId = (value: unknown): value is string =>
  boundedText(value, 128) && /^[A-Za-z0-9._:-]+$/.test(value);

const routePageRef = (value: unknown): value is string =>
  typeof value === "string" && parseNodeRef(value).ok;

const routeSession = (value: unknown): value is StationBrowserSession =>
  plain(value) &&
  exactKeys(value, ["hostId", "sessionId", "generation"]) &&
  routeId(value.hostId) &&
  routeId(value.sessionId) &&
  routeId(value.generation);

/**
 * Exact untrusted HTTP decoder for the origin control route. Only the typed
 * station protocol is representable; paths, programs, forwarding, bounds,
 * and arbitrary wrapper arguments have no fields.
 */
export const decodeStationBrowserRouteInput = (
  value: unknown,
): StationBrowserRouteInputDecode => {
  if (!plain(value) || typeof value.action !== "string") {
    return { ok: false };
  }
  const targetHostId =
    value.targetHostId === undefined
      ? undefined
      : routeId(value.targetHostId)
        ? value.targetHostId
        : null;
  if (targetHostId === null) return { ok: false };

  if (
    value.action === "doctor" ||
    value.action === "discover" ||
    value.action === "list"
  ) {
    return exactKeys(value, ["action", "targetHostId"]) &&
        targetHostId !== undefined
      ? {
          ok: true,
          input: {
            action: value.action,
            targetHostId,
          },
        }
      : { ok: false };
  }

  if (!routePageRef(value.pageRef)) return { ok: false };
  if (value.action === "open") {
    return exactKeys(value, ["action", "pageRef"], ["targetHostId"])
      ? {
          ok: true,
          input: {
            action: "open",
            pageRef: value.pageRef,
            ...(targetHostId === undefined ? {} : { targetHostId }),
          },
        }
      : { ok: false };
  }

  if (
    value.action !== "goto" &&
    value.action !== "eval" &&
    value.action !== "screenshot" &&
    value.action !== "state" &&
    value.action !== "close" &&
    value.action !== "stop"
  ) {
    return { ok: false };
  }
  if (!routeSession(value.session)) return { ok: false };
  const payload: Readonly<Record<string, string>> | null | undefined =
    value.action === "goto"
      ? plain(value.payload) &&
        exactKeys(value.payload, ["url"]) &&
        boundedText(value.payload.url)
        ? { url: value.payload.url }
        : undefined
      : value.action === "eval"
        ? plain(value.payload) &&
          exactKeys(value.payload, ["code"]) &&
          boundedText(value.payload.code, STATION_BROWSER_MAX_EVAL_BYTES)
          ? { code: value.payload.code }
          : undefined
        : value.payload === undefined
          ? null
          : undefined;
  if (payload === undefined) return { ok: false };
  const required =
    value.action === "goto" || value.action === "eval"
      ? ["action", "pageRef", "session", "payload"]
      : ["action", "pageRef", "session"];
  if (!exactKeys(value, required, ["targetHostId"])) return { ok: false };
  return {
    ok: true,
    input: {
      action: value.action,
      pageRef: value.pageRef,
      session: value.session,
      ...(payload === null ? {} : { payload }),
      ...(targetHostId === undefined ? {} : { targetHostId }),
    },
  };
};

export interface StationBrowserSigningIdentity {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface StationBrowserLocalClient {
  /**
   * Existing owner-local Unix-socket product path. Implementations must not
   * create a second browser/session service or serialize through SSH.
   */
  readonly execute: (
    request: StationBrowserRequest,
    signal?: AbortSignal,
  ) => Promise<StationBrowserResponse>;
}

export interface StationBrowserRouterDeps {
  /** Physical station id of this router process. */
  readonly stationId: string;
  readonly hosts: () => ReadonlyArray<RemoteHost>;
  /** Resolves only canonical page refs from the current document projection. */
  readonly resolvePageHost: (
    pageRef: string,
  ) => Promise<Readonly<{ hostId: string }> | undefined>;
  readonly local: StationBrowserLocalClient;
  readonly ssh: typeof SshTransport.Service;
  /** Loaded only for a remote branch, never for local execution. */
  readonly signingIdentity: () => Promise<StationBrowserSigningIdentity>;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly nonce?: () => string;
  readonly dispatchRemote?: typeof dispatchStationBrowser;
}

export type StationBrowserRouterErrorCode =
  | "invalid_route"
  | "unknown_host"
  | "host_capability"
  | "wrong_host"
  | "stale_page"
  | "malformed_response"
  | "admission"
  | "cancelled"
  | "transport";

export class StationBrowserRouterError extends Error {
  constructor(
    readonly code: StationBrowserRouterErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "StationBrowserRouterError";
  }
}

const canonicalId = (value: string): boolean =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value);

const resolveHost = (
  hosts: ReadonlyArray<RemoteHost>,
  hostId: string,
): RemoteHost => {
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (host === undefined) {
    throw new StationBrowserRouterError(
      "unknown_host",
      "browser target is not a registered host",
    );
  }
  if (!hostHasCapability(host, BROWSER_HOST_CAPABILITY)) {
    throw new StationBrowserRouterError(
      "host_capability",
      "browser target does not advertise browser capability",
    );
  }
  return host;
};

const structuralResponse = (
  response: StationBrowserResponse,
  request: StationBrowserRequest,
): StationBrowserResponse => {
  const decoded = decodeStationBrowserResponse(JSON.stringify({
    ...response,
    data: response.ok ? response.data : null,
    error: response.ok ? null : response.error,
  }));
  if (
    typeof decoded === "string" ||
    decoded.requestId !== request.requestId ||
    decoded.action !== request.action ||
    decoded.hostId !== request.targetStationId
  ) {
    throw new StationBrowserRouterError(
      "malformed_response",
      "browser station returned an invalid response",
    );
  }
  return decoded;
};

const asRouterError = (
  error: unknown,
): StationBrowserRouterError => {
  if (error instanceof StationBrowserRouterError) return error;
  if (error instanceof StationBrowserOriginAdmissionError) {
    return new StationBrowserRouterError(
      error.denial === "cancelled" ? "cancelled" : "admission",
      "browser station route admission failed",
      { cause: error },
    );
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new StationBrowserRouterError(
      "cancelled",
      "browser station request was cancelled",
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "InterruptedException"
  ) {
    return new StationBrowserRouterError(
      "cancelled",
      "browser station request was cancelled",
    );
  }
  return new StationBrowserRouterError(
    "transport",
    "browser station request failed",
    { cause: error },
  );
};

/**
 * One host-qualified browser router. Page and session operations derive their
 * physical host from current document/session truth. Generic station queries
 * require an explicit registered target.
 */
export const makeStationBrowserRouter = (deps: StationBrowserRouterDeps) => {
  if (!canonicalId(deps.stationId)) {
    throw new StationBrowserRouterError(
      "invalid_route",
      "router station identity is not canonical",
    );
  }
  const dispatchRemote = deps.dispatchRemote ?? dispatchStationBrowser;
  const globalRemote = Effect.unsafeMakeSemaphore(
    STATION_BROWSER_MAX_REMOTE_CONCURRENCY,
  );
  const hostRemote = new Map<string, Effect.Semaphore>();
  const semaphoreFor = (hostId: string): Effect.Semaphore => {
    const existing = hostRemote.get(hostId);
    if (existing !== undefined) return existing;
    const created = Effect.unsafeMakeSemaphore(
      STATION_BROWSER_MAX_REMOTE_CONCURRENCY_PER_HOST,
    );
    hostRemote.set(hostId, created);
    return created;
  };

  const deriveTarget = async (
    input: StationBrowserRouteInput,
  ): Promise<string> => {
    if (
      input.action === "doctor" ||
      input.action === "discover" ||
      input.action === "list"
    ) {
      if (!canonicalId(input.targetHostId)) {
        throw new StationBrowserRouterError(
          "invalid_route",
          "browser target host is not canonical",
        );
      }
      return input.targetHostId;
    }
    if (!("pageRef" in input)) {
      throw new StationBrowserRouterError(
        "invalid_route",
        "browser page route is incomplete",
      );
    }
    const page = await deps.resolvePageHost(input.pageRef);
    if (page === undefined) {
      throw new StationBrowserRouterError(
        "stale_page",
        "browser page is absent from the current document projection",
      );
    }
    if (!canonicalId(page.hostId)) {
      throw new StationBrowserRouterError(
        "stale_page",
        "browser page host is not canonical",
      );
    }
    if (
      input.targetHostId !== undefined &&
      input.targetHostId !== page.hostId
    ) {
      throw new StationBrowserRouterError(
        "wrong_host",
        "caller host assertion does not match current document truth",
      );
    }
    if ("session" in input && input.session.hostId !== page.hostId) {
      throw new StationBrowserRouterError(
        "wrong_host",
        "browser session host does not match current document truth",
      );
    }
    return page.hostId;
  };

  const route = async (
    admission: StationBrowserRouteAdmission,
    input: StationBrowserRouteInput,
    signal?: AbortSignal,
  ): Promise<StationBrowserResponse> => {
    if (signal?.aborted) {
      throw new StationBrowserRouterError(
        "cancelled",
        "browser station request was cancelled",
      );
    }
    try {
      const targetStationId = await deriveTarget(input);
      const host = resolveHost(deps.hosts(), targetStationId);
      if (targetStationId !== deps.stationId && host.kind !== "remote") {
        throw new StationBrowserRouterError(
          "wrong_host",
          "browser target is not the current station or a configured Remote",
        );
      }
      if (
        targetStationId !== deps.stationId &&
        host.endpoint === undefined
      ) {
        throw new StationBrowserRouterError(
          "unknown_host",
          "browser Remote has no configured SSH endpoint",
        );
      }
      const witness = await admission.admit(
        {
          targetStationId,
          ...("pageRef" in input ? { pageRef: input.pageRef } : {}),
        },
        signal,
      );
      const revalidatedTargetStationId = await deriveTarget(input);
      if (revalidatedTargetStationId !== targetStationId) {
        throw new StationBrowserRouterError(
          "stale_page",
          "browser page host changed during route admission",
        );
      }

      const now = (deps.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new StationBrowserRouterError(
          "invalid_route",
          "browser route clock is invalid",
        );
      }
      const unsigned = {
        version: 1 as const,
        requestId: (deps.requestId ?? randomUUID)(),
        targetStationId,
        action: input.action,
        ...("pageRef" in input ? { pageRef: input.pageRef } : {}),
        ...("session" in input ? { session: input.session } : {}),
        ...("payload" in input && input.payload !== undefined
          ? { payload: input.payload }
          : {}),
        issuedAt: now,
        expiresAt: now + STATION_BROWSER_ROUTE_TTL_MS,
        nonce: (deps.nonce ?? (() => randomBytes(24).toString("hex")))(),
      } satisfies Omit<
        StationBrowserRequest,
        "authority" | "originStationId" | "agentRef"
      >;
      const request = bindStationBrowserRequest(witness, unsigned);

      if (targetStationId === deps.stationId) {
        return structuralResponse(
          await deps.local.execute(request, signal),
          request,
        );
      }

      const signing = await deps.signingIdentity();
      const envelope = mintStationBrowserEnvelope(
        witness,
        unsigned,
        signing.keyId,
        signing.privateKey,
      );
      const operation = semaphoreFor(targetStationId).withPermits(1)(
        globalRemote.withPermits(1)(
          dispatchRemote(deps.ssh, deps.hosts(), envelope),
        ),
      ) as Effect.Effect<
        StationBrowserResponse,
        StationBrowserTransportError | SshError
      >;
      const response = await Effect.runPromise(operation, { signal });
      return structuralResponse(response, request);
    } catch (error) {
      if (signal?.aborted) {
        throw new StationBrowserRouterError(
          "cancelled",
          "browser station request was cancelled",
        );
      }
      throw asRouterError(error);
    }
  };

  return Object.freeze({ route });
};

export type StationBrowserRouter = ReturnType<typeof makeStationBrowserRouter>;
