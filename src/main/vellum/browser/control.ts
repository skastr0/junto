import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open as openFile,
  opendir,
  unlink,
} from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Either, Schema } from "effect";
import { decodeCanvasDoc } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import {
  CONTROL_CAPABILITY_HEADER,
  CONTROL_ROUTES,
  CONTROL_HEADERS_TIMEOUT_MS,
  CONTROL_MAX_BODY_BYTES,
  CONTROL_MAX_HEADER_BYTES,
  CONTROL_REQUEST_ID_HEADER,
  CONTROL_REQUEST_TIMEOUT_MS,
  CONTROL_TOKEN_HEADER,
  STATION_BROWSER_ORIGIN_ROUTE_PATH,
  controlDir,
  controlErr,
  controlOk,
  controlShotsDir,
  controlSocketPath,
  controlTokenPath,
  encodeControlEnvelope,
  inspectControlJson,
  inspectEvalResult,
  isValidControlCapability,
  isValidControlRequestId,
  CloseRequest,
  EvalRequest,
  GotoRequest,
  OpenRequest,
  ScreenshotRequest,
  StopRequest,
  type ControlEnvelope,
  type ControlErrorTag,
  type PageNodeRow,
} from "@shared/browser-control";
import type { CanvasDoc } from "@shared/canvas";
import { resolveNodeHostId } from "@shared/station";
import {
  makeEdgeGrantService,
  type EdgeGrantDenial,
  type EdgeGrantService,
} from "./edge-grant";
import {
  BROWSER_CONTROL_HANDLER_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
  BROWSER_MAX_ACTIVE_HTTP_HANDLERS,
  BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES,
  BROWSER_MAX_CANVAS_SCAN_BYTES,
  BROWSER_MAX_CANVAS_SOURCE_BYTES,
  BROWSER_MAX_EVAL_RESULT_NODES,
  BROWSER_MAX_LIST_ROWS,
  BROWSER_MAX_METADATA_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
  utf8ByteLength,
} from "@shared/browser-limits";
import type { BrowserResult, BrowserSessionAuthorizationSnapshot } from "./sessions";
import { BROWSER_UI_SESSION_OWNER, BrowserSessionService } from "./sessions";
import type { PageTargetResolver } from "./page-target";
import type { ResolvedPageTarget } from "./page-target";
import {
  BrowserCapabilityDenied,
  BrowserCapabilityRegistry,
  BrowserCapabilityStateDenied,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityAction,
  type BrowserCapabilityCompletionOutcome,
  type BrowserCapabilityLease,
  type BrowserCapabilityPreflightResult,
  type BrowserCapabilityTarget,
  type BrowserCapabilityUseTarget,
} from "./capabilities";
import {
  canonicalStationBrowserJson,
  decodeStationBrowserResponse,
  STATION_BROWSER_MAX_FRAME_BYTES,
  type StationBrowserResponse,
} from "@shared/station-browser";
import type { StationBrowserWrapper } from "./station-wrapper";
import {
  StationBrowserOriginAdmissionError,
  type StationBrowserRouteAdmission,
} from "./station-delegation";
import {
  decodeStationBrowserRouteInput,
  StationBrowserRouterError,
  type StationBrowserRouter,
} from "./station-router";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlListenerLeaseHeld,
  controlSocketPathOwnedByLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
  removeOwnedControlSocketPath,
  rotateControlFileToken,
  type ControlSocketPathIdentity,
} from "../control-filesystem";

// Local control plane for agents (the browser ACI): a tiny HTTP server on a
// unix domain socket at ~/.vellum/browser/control.sock, hosted by the Electron
// main process and calling the warm-session service directly. Security model:
// filesystem (socket + token file are chmod 600 in the user's home) plus a
// bearer token on EVERY request — so a same-host process still needs read
// access to the token file. The service has no TCP transport.

// ---------------------------------------------------------------------------
// Transport token: rotate on every app start and atomically replace any stale
// file without following it. This is an owner-local, pre-body admission gate;
// browser authority is independently delegated by short-lived capabilities.

export const rotateControlToken = (tokenPath: string): string => {
  return rotateControlFileToken(tokenPath);
};

export const tokenMatches = (presented: string | undefined, expected: string): boolean => {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

// ---------------------------------------------------------------------------
// Page-node listing: link nodes upgraded to entity.kind "page" across every
// .canvas document. Read-only; a corrupt canvas degrades to zero rows for that
// file rather than failing the listing (canvas-ls precedent).

const readBoundedCanvasSource = async (
  path: string,
  remainingBytes: number,
): Promise<{ readonly source: string; readonly bytes: number } | undefined> => {
  const maxBytes = Math.min(BROWSER_MAX_CANVAS_SOURCE_BYTES, remainingBytes);
  if (maxBytes <= 0) return undefined;
  const admitted = await lstat(path);
  if (!admitted.isFile() || admitted.size > maxBytes) return undefined;

  const handle = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { source: buffer.subarray(0, offset).toString("utf8"), bytes: offset };
  } finally {
    await handle.close();
  }
};

const boundedRuntimeValue = (value: number | undefined, hardLimit: number): number =>
  value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, hardLimit)
    : hardLimit;

export interface PageListRuntime {
  /** Tests may lower, never raise, the production directory admission ceiling. */
  readonly maxDirectoryEntries?: number;
  /** Tests may lower, never raise, the production aggregate source-byte ceiling. */
  readonly maxScanBytes?: number;
}

export const listPageNodes = async (
  canvasesDir: string,
  sessions?: BrowserSessionService,
  runtime: PageListRuntime = {},
  owner = BROWSER_UI_SESSION_OWNER,
): Promise<ReadonlyArray<PageNodeRow>> => {
  await mkdir(canvasesDir, { recursive: true });
  const maxDirectoryEntries = boundedRuntimeValue(
    runtime.maxDirectoryEntries,
    BROWSER_MAX_CANVAS_DIRECTORY_ENTRIES,
  );
  const maxScanBytes = boundedRuntimeValue(
    runtime.maxScanBytes,
    BROWSER_MAX_CANVAS_SCAN_BYTES,
  );
  const directory = await opendir(canvasesDir);
  const files: string[] = [];
  let directoryEntries = 0;
  for await (const entry of directory) {
    directoryEntries += 1;
    if (directoryEntries > maxDirectoryEntries) break;
    if (entry.isFile() && entry.name.endsWith(".canvas")) files.push(entry.name);
  }
  const rows: PageNodeRow[] = [];
  let responseBytes = utf8ByteLength(encodeControlEnvelope(controlOk([])));
  let responseNodes = 3; // envelope object + ok boolean + data array
  let scannedBytes = 0;
  for (const file of files.sort()) {
    try {
      const canvasName = file.slice(0, -".canvas".length);
      if (!isUtf8WithinLimit(canvasName, BROWSER_MAX_METADATA_BYTES)) continue;
      const admitted = await readBoundedCanvasSource(
        join(canvasesDir, file),
        maxScanBytes - scannedBytes,
      );
      if (admitted === undefined) continue;
      scannedBytes += admitted.bytes;
      const decoded = decodeCanvasDoc(JSON.parse(admitted.source));
      if (Either.isLeft(decoded)) continue;
      for (const node of decoded.right.nodes) {
        if (node.type !== "link" || node.ether?.entity?.kind !== "page") continue;
        if (
          !isUtf8WithinLimit(node.id, BROWSER_MAX_METADATA_BYTES) ||
          !isUtf8WithinLimit(node.url, BROWSER_MAX_URL_BYTES)
        ) {
          continue;
        }
        const profile = node.ether.browser?.profile;
        if (profile !== undefined && !isUtf8WithinLimit(profile, BROWSER_MAX_METADATA_BYTES)) {
          continue;
        }
        const ref = formatNodeRef({
          canvasName,
          nodeId: node.id,
        });
        if (!isUtf8WithinLimit(ref, BROWSER_MAX_REF_BYTES)) continue;
        const sessionId = sessions?.sessionIdForRefForOwner(owner, ref) ?? null;
        if (sessionId !== null && !isValidBrowserSessionId(sessionId)) continue;
        const row: PageNodeRow = {
          ref,
          sessionId,
          canvas: canvasName,
          nodeId: node.id,
          hostId: resolveNodeHostId(node),
          url: node.url,
          ...(profile !== undefined ? { profile } : {}),
        };
        const rowBytes = utf8ByteLength(JSON.stringify(row)) + (rows.length === 0 ? 0 : 1);
        const rowNodes = 1 + Object.keys(row).length;
        if (
          rows.length >= BROWSER_MAX_LIST_ROWS ||
          responseBytes + rowBytes > BROWSER_CONTROL_MAX_RESPONSE_BYTES ||
          responseNodes + rowNodes > BROWSER_MAX_EVAL_RESULT_NODES
        ) {
          return rows;
        }
        rows.push(row);
        responseBytes += rowBytes;
        responseNodes += rowNodes;
      }
    } catch {
      // unreadable/corrupt canvas — skip, listing must not crash
    }
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Route handlers, transport-free for tests: (route, body) → envelope.

const httpStatus = (tag: ControlErrorTag): number =>
  tag === "unauthorized"
    ? 401
    : tag === "not_found"
      ? 404
      : tag === "forbidden"
        ? 403
        : tag === "timeout"
          ? 504
          : tag === "cancelled"
            ? 408
            : tag === "resource_exhausted"
              ? 429
              : tag === "result_too_large"
                ? 413
                : tag === "unsupported_result" ||
                    tag === "unsupported_capability"
                  ? 422
                  : tag === "bad_request" || tag === "invalid"
                    ? 400
                    : 500;

const fromResult = <T>(result: BrowserResult<T>): ControlEnvelope<T> =>
  result.ok ? controlOk(result.data) : controlErr(result.code, result.message);

const decodeBody =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (body: unknown): Either.Either<A, ControlEnvelope<never>> => {
    const decoded = Schema.decodeUnknownEither(schema)(body);
    return Either.isLeft(decoded)
      ? Either.left(controlErr("bad_request", String(decoded.left.message).slice(0, 400)))
      : Either.right(decoded.right);
  };

export interface ControlDeps {
  readonly sessions: BrowserSessionService;
  readonly capabilities: BrowserCapabilityRegistry;
  readonly resolvePageTarget: PageTargetResolver;
  readonly version: string;
  readonly canvasesDir: string;
  readonly shotsDir: string;
  readonly screenshotFiles?: {
    readonly ensureDirectory?: (path: string) => Promise<void>;
    readonly makePath?: (directory: string) => string;
    readonly writeExclusive?: (path: string, data: Uint8Array) => Promise<void>;
    readonly remove?: (path: string) => Promise<void>;
  };
  /**
   * Process-bind + edge authz admission. When present, protected routes admit
   * via Unix peer PID → registered agent|herdr process (no client claim).
   */
  readonly edgeGrant?: EdgeGrantService;
  /**
   * Fixed station-to-station wrapper hosted on this same Unix listener.
   * Signed-envelope verification remains independent of process-bind routes.
   */
  readonly stationBrowserWrapper?: StationBrowserWrapper;
  /**
   * Server lifecycle hook. The HTTP host uses this to retain the actual route
   * promise after the request-facing cancellation race has settled.
   */
  readonly retainRouteOperation?: <A>(
    action: BrowserCapabilityAction,
    operation: Promise<A>,
  ) => Promise<A>;
}

const ensureScreenshotDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("screenshot directory must be a real directory");
  }
  await chmod(path, 0o700);
};

const writeScreenshotExclusive = async (path: string, data: Uint8Array): Promise<void> => {
  const handle = await openFile(path, "wx", 0o600);
  let complete = false;
  try {
    await handle.writeFile(data);
    await handle.chmod(0o600);
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await unlink(path).catch(() => undefined);
  }
};

const removeScreenshot = async (path: string): Promise<void> => {
  await unlink(path);
};

interface ControlAuthorization {
  readonly capability: string;
  /** Exact registry identity minted during process/edge admission. */
  readonly expectedPrincipal?: BrowserAutomationPrincipal;
  readonly requestId: string;
}

interface ControlRouteHandler {
  readonly action: BrowserCapabilityAction | null;
  readonly preflight: (
    capability: string | undefined,
    expectedPrincipal?: BrowserAutomationPrincipal,
  ) => BrowserCapabilityPreflightResult;
  readonly run: (
    body: unknown,
    authorization: ControlAuthorization | undefined,
    signal?: AbortSignal,
  ) => Promise<ControlEnvelope<unknown>>;
}

type ControlHandlers = Readonly<Record<string, ControlRouteHandler>>;

const capabilityDenied = (
  denial: "unauthorized" | "forbidden",
): ControlEnvelope<never> =>
  controlErr(denial, "browser capability denied");

const capabilityError = (error: unknown): ControlEnvelope<never> => {
  if (error instanceof BrowserCapabilityDenied) {
    return capabilityDenied(
      error.reason === "credential" ||
        error.reason === "expired" ||
        error.reason === "closed"
        ? "unauthorized"
        : "forbidden",
    );
  }
  if (error instanceof BrowserCapabilityStateDenied) return capabilityDenied("forbidden");
  return controlErr("failed", "browser control operation failed");
};

const combineAbortSignals = (
  requestSignal: AbortSignal | undefined,
  capabilitySignal: AbortSignal,
): { readonly signal: AbortSignal; readonly dispose: () => void } => {
  const controller = new AbortController();
  const sources = [requestSignal, capabilitySignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const relay = (): void => controller.abort(source.reason);
    source.addEventListener("abort", relay, { once: true });
    listeners.push([source, relay]);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    },
  };
};

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

const exactOrigins = (values: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const origins = values.map(exactHttpOrigin);
  if (origins.some((origin) => origin === undefined)) return undefined;
  return [...new Set(origins as ReadonlyArray<string>)].sort();
};

const useTargetForResolved = (
  target: ResolvedPageTarget,
): BrowserCapabilityUseTarget | undefined => {
  const origins = exactOrigins([target.url]);
  return origins === undefined
    ? undefined
    : {
        ref: target.ref,
        hostId: target.hostId,
        profile: target.profile,
        exactOrigins: origins,
      };
};

const scopeAllows = (
  scope: ReadonlyArray<BrowserCapabilityTarget>,
  target: BrowserCapabilityUseTarget,
): boolean =>
  scope.some(
    (allowed) =>
      allowed.ref === target.ref &&
      allowed.hostId === target.hostId &&
      allowed.profile === target.profile &&
      target.exactOrigins.every((origin) => allowed.exactOrigins.includes(origin)),
  );

const sameResolvedTarget = (
  left: ResolvedPageTarget,
  right: ResolvedPageTarget,
): boolean =>
  left.ref === right.ref &&
  left.nodeId === right.nodeId &&
  left.hostId === right.hostId &&
  left.url === right.url &&
  left.profile === right.profile;

const releaseOutcome = (
  envelope: ControlEnvelope<unknown>,
): BrowserCapabilityCompletionOutcome =>
  envelope.ok ? "success" : envelope.error._tag === "cancelled" ? "cancelled" : "failed";

export const makeControlHandlers = (deps: ControlDeps): ControlHandlers => {
  const screenshotFiles = {
    ensureDirectory: deps.screenshotFiles?.ensureDirectory ?? ensureScreenshotDirectory,
    makePath:
      deps.screenshotFiles?.makePath ??
      ((directory: string) => join(directory, `${randomBytes(24).toString("hex")}.png`)),
    writeExclusive: deps.screenshotFiles?.writeExclusive ?? writeScreenshotExclusive,
    remove: deps.screenshotFiles?.remove ?? removeScreenshot,
  };

  const protectedRun = async (
    action: BrowserCapabilityAction,
    authorization: ControlAuthorization | undefined,
    requestSignal: AbortSignal | undefined,
    run: (lease: BrowserCapabilityLease, signal: AbortSignal) => Promise<ControlEnvelope<unknown>>,
  ): Promise<ControlEnvelope<unknown>> => {
    if (authorization === undefined) return capabilityDenied("unauthorized");
    let lease: BrowserCapabilityLease;
    try {
      lease = deps.capabilities.authorize(
        authorization.capability,
        { action },
        {
          requestId: authorization.requestId,
          ...(authorization.expectedPrincipal === undefined
            ? {}
            : { expectedPrincipal: authorization.expectedPrincipal }),
        },
      );
    } catch (error) {
      return capabilityError(error);
    }
    const combined = combineAbortSignals(requestSignal, lease.signal);
    let outcome: BrowserCapabilityCompletionOutcome = "failed";
    let removeAbortListener: (() => void) | undefined;
    try {
      if (combined.signal.aborted) {
        outcome = "cancelled";
        return controlErr("cancelled", "browser control request was cancelled");
      }

      const routeOperation = Promise.resolve()
        .then(() => run(lease, combined.signal));
      const retainedRouteOperation = deps.retainRouteOperation?.(
        action,
        routeOperation,
      ) ?? routeOperation;
      const operation = retainedRouteOperation
        .then(
          (envelope) => ({ kind: "completed" as const, envelope }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        );
      const aborted = new Promise<{ readonly kind: "aborted" }>((resolveAbort) => {
        const onAbort = (): void => resolveAbort({ kind: "aborted" });
        combined.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => combined.signal.removeEventListener("abort", onAbort);
      });
      const result = await Promise.race([operation, aborted]);
      if (result.kind === "aborted") {
        outcome = "cancelled";
        return controlErr("cancelled", "browser control request was cancelled");
      }
      if (result.kind === "failed") {
        if (combined.signal.aborted) {
          outcome = "cancelled";
          return controlErr("cancelled", "browser control request was cancelled");
        }
        return capabilityError(result.error);
      }
      outcome = releaseOutcome(result.envelope);
      return result.envelope;
    } finally {
      removeAbortListener?.();
      combined.dispose();
      lease.release(outcome);
    }
  };

  const route = (
    action: BrowserCapabilityAction | null,
    run: ControlRouteHandler["run"],
  ): ControlRouteHandler => ({
    action,
    preflight: (capability, expectedPrincipal) =>
      action === null
        ? { ok: true }
        : deps.capabilities.preflight(capability, action, expectedPrincipal),
    run,
  });

  const withoutBody = (
    action: BrowserCapabilityAction,
    run: (lease: BrowserCapabilityLease, signal: AbortSignal) => Promise<ControlEnvelope<unknown>>,
  ): ControlRouteHandler =>
    route(action, async (body, authorization, signal) => {
      if (body !== undefined) return controlErr("bad_request", "request body is not accepted");
      return protectedRun(action, authorization, signal, run);
    });

  const withBody =
    <A, I>(
      action: BrowserCapabilityAction,
      schema: Schema.Schema<A, I>,
      keys: ReadonlyArray<string>,
      run: (
        input: A,
        lease: BrowserCapabilityLease,
        signal: AbortSignal,
      ) => Promise<ControlEnvelope<unknown>>,
    ) =>
    route(action, async (body, authorization, signal) => {
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !keys.includes(key))
      ) {
        return controlErr("bad_request", "request contains unknown or invalid fields");
      }
      const decoded = decodeBody(schema)(body);
      if (Either.isLeft(decoded)) return decoded.left;
      return protectedRun(action, authorization, signal, (lease, combinedSignal) =>
        run(decoded.right, lease, combinedSignal),
      );
    });

  const targetForSession = (
    owner: string,
    sessionId: string,
    additionalUrls: ReadonlyArray<string> = [],
  ) => {
    const snapshot = deps.sessions.authorizationSnapshotForOwner(owner, sessionId);
    if (!snapshot.ok) return { ok: false as const, envelope: fromResult(snapshot) };
    if (snapshot.data.origin === undefined) {
      return { ok: false as const, envelope: capabilityDenied("forbidden") };
    }
    const origins = exactOrigins([snapshot.data.origin, ...additionalUrls]);
    if (origins === undefined) {
      return { ok: false as const, envelope: capabilityDenied("forbidden") };
    }
    return {
      ok: true as const,
      snapshot: snapshot.data,
      target: {
        ref: snapshot.data.ref,
        hostId: snapshot.data.hostId,
        profile: snapshot.data.profile,
        exactOrigins: origins,
        generation: snapshot.data.generation,
      } satisfies BrowserCapabilityUseTarget,
    };
  };

  const handlers: Record<string, ControlRouteHandler> = {
    "GET /doctor": route(null, async (body) =>
      body === undefined
        ? controlOk({ status: "ok" as const })
        : controlErr("bad_request", "request body is not accepted"),
    ),

    "GET /profiles": withoutBody("profiles", async (lease, signal) => {
      if (signal.aborted) return controlErr("cancelled", "browser control request was cancelled");
      const result = await deps.sessions.listProfiles();
      if (!result.ok) return fromResult(result);
      const allowedProfiles = new Set(lease.scope.map((target) => target.profile));
      const filtered = result.data.filter((profile) => allowedProfiles.has(profile.id));
      return controlOk(filtered.slice(0, BROWSER_MAX_LIST_ROWS));
    }),

    "GET /sessions": withoutBody("sessions", async (lease, signal) => {
      const result = deps.sessions.listForOwner(lease.auditId);
      if (!result.ok) return fromResult(result);
      const filtered = result.data.filter((session) => {
        if (signal.aborted) return false;
        const scoped = targetForSession(lease.auditId, session.sessionId);
        return scoped.ok &&
          scopeAllows(lease.scope, scoped.target) &&
          lease.boundGenerationInScope(scoped.target.ref) === scoped.snapshot.generation;
      });
      return signal.aborted
        ? controlErr("cancelled", "browser control request was cancelled")
        : controlOk(filtered.slice(0, BROWSER_MAX_LIST_ROWS));
    }),

    "GET /pages": withoutBody("pages", async (lease, signal) => {
      const rows = await listPageNodes(
        deps.canvasesDir,
        deps.sessions,
        {},
        lease.auditId,
      );
      const filtered: PageNodeRow[] = [];
      for (const row of rows) {
        if (signal.aborted) return controlErr("cancelled", "browser control request was cancelled");
        if (!lease.scope.some((allowed) => allowed.ref === row.ref)) continue;
        const resolved = await deps.resolvePageTarget(row.ref);
        if (!resolved.ok || resolved.data.ref !== row.ref) continue;
        const target = useTargetForResolved(resolved.data);
        if (target === undefined || !scopeAllows(lease.scope, target)) continue;
        let sessionId: string | null = null;
        if (row.sessionId !== null) {
          const current = targetForSession(lease.auditId, row.sessionId);
          if (
            current.ok &&
            current.snapshot.ref === resolved.data.ref &&
            current.snapshot.profile === resolved.data.profile &&
            scopeAllows(lease.scope, current.target) &&
            lease.boundGenerationInScope(current.target.ref) === current.snapshot.generation
          ) {
            sessionId = row.sessionId;
          }
        }
        filtered.push({
          ref: resolved.data.ref,
          sessionId,
          canvas: row.canvas,
          nodeId: resolved.data.nodeId,
          hostId: resolved.data.hostId,
          url: resolved.data.url,
          profile: resolved.data.profile,
        });
        if (filtered.length >= BROWSER_MAX_LIST_ROWS) break;
      }
      return controlOk(filtered);
    }),

    "POST /open": withBody("open", OpenRequest, ["ref"], async (input, lease, signal) => {
      if (!lease.scope.some((allowed) => allowed.ref === input.ref)) {
        return capabilityDenied("forbidden");
      }
      const resolved = await deps.resolvePageTarget(input.ref);
      if (!resolved.ok) return controlErr(resolved.code, resolved.message);
      if (resolved.data.ref !== input.ref) return capabilityDenied("forbidden");
      const target = useTargetForResolved(resolved.data);
      if (target === undefined) return capabilityDenied("forbidden");
      const admittedGeneration = lease.boundGenerationInScope(resolved.data.ref);
      lease.checkTarget(
        admittedGeneration === undefined
          ? target
          : { ...target, generation: admittedGeneration },
      );

      const opened = await deps.sessions.openForOwner(
        lease.auditId,
        resolved.data,
        signal,
        () => deps.resolvePageTarget(input.ref),
      );
      if (!opened.ok) {
        deps.sessions.destroyOwnerSessions(lease.auditId, "browser open failed closed");
        return fromResult(opened);
      }
      const failOpen = <A>(envelope: ControlEnvelope<A>): ControlEnvelope<A> => {
        deps.sessions.destroyOwnerSessions(lease.auditId, "browser open authorization failed");
        return envelope;
      };

      try {
        const terminal = await deps.sessions.awaitNavigationTerminalForOwner(
          lease.auditId,
          opened.data.sessionId,
          signal,
        );
        if (!terminal.ok) return failOpen(fromResult(terminal));

        const refreshed = await deps.resolvePageTarget(input.ref);
        if (
          !refreshed.ok ||
          !sameResolvedTarget(resolved.data, refreshed.data)
        ) {
          return failOpen(capabilityDenied("forbidden"));
        }
        const current = deps.sessions.authorizationSnapshotForOwner(
          lease.auditId,
          terminal.data.sessionId,
        );
        if (
          !current.ok ||
          current.data.ref !== resolved.data.ref ||
          current.data.hostId !== resolved.data.hostId ||
          current.data.profile !== resolved.data.profile ||
          current.data.origin !== target.exactOrigins[0] ||
          current.data.navigationInFlight
        ) {
          return failOpen(capabilityDenied("forbidden"));
        }
        const currentGeneration = lease.boundGeneration(resolved.data.ref);
        if (currentGeneration === undefined) {
          lease.bindGeneration(resolved.data.ref, current.data.generation);
        } else if (currentGeneration !== current.data.generation) {
          return failOpen(capabilityDenied("forbidden"));
        }
        const finalState = deps.sessions.authorizationSnapshotForOwner(
          lease.auditId,
          current.data.generation,
        );
        return finalState.ok &&
          finalState.data.ref === resolved.data.ref &&
          finalState.data.profile === resolved.data.profile &&
          finalState.data.origin === target.exactOrigins[0] &&
          !finalState.data.navigationInFlight &&
          lease.boundGeneration(resolved.data.ref) === finalState.data.generation
          ? controlOk(terminal.data)
          : failOpen(capabilityDenied("forbidden"));
      } catch (error) {
        deps.sessions.destroyOwnerSessions(lease.auditId, "browser open authorization failed");
        throw error;
      }
    }),

    "POST /goto": withBody("goto", GotoRequest, ["sessionId", "url"], async (input, lease, signal) => {
      const scoped = targetForSession(lease.auditId, input.sessionId, [input.url]);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const destinationOrigin = exactHttpOrigin(input.url);
      if (destinationOrigin === undefined) return capabilityDenied("forbidden");

      const navigated = deps.sessions.gotoForOwner(lease.auditId, input.sessionId, input.url, signal);
      if (!navigated.ok) return fromResult(navigated);
      if (navigated.data.sessionId !== scoped.snapshot.generation) {
        lease.rollGeneration(
          scoped.target.ref,
          scoped.snapshot.generation,
          navigated.data.sessionId,
        );
      }
      const terminal = await deps.sessions.awaitNavigationTerminalForOwner(
        lease.auditId,
        navigated.data.sessionId,
        signal,
      );
      if (!terminal.ok) return fromResult(terminal);
      const current = deps.sessions.authorizationSnapshotForOwner(
        lease.auditId,
        terminal.data.sessionId,
      );
      return current.ok &&
        current.data.ref === scoped.snapshot.ref &&
        current.data.profile === scoped.snapshot.profile &&
        current.data.origin === destinationOrigin &&
        !current.data.navigationInFlight &&
        lease.boundGeneration(scoped.target.ref) === current.data.generation
        ? controlOk(terminal.data)
        : capabilityDenied("forbidden");
    }),

    "POST /eval": withBody("eval", EvalRequest, ["sessionId", "code"], async (input, lease, signal) => {
      const scoped = targetForSession(lease.auditId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const result = await deps.sessions.evalForOwner(lease.auditId, input.sessionId, input.code, signal);
      if (!result.ok) return fromResult(result);
      const current = targetForSession(lease.auditId, input.sessionId);
      if (
        !current.ok ||
        current.snapshot.navigationInFlight ||
        current.snapshot.generation !== scoped.snapshot.generation ||
        current.snapshot.ref !== scoped.snapshot.ref ||
        current.snapshot.profile !== scoped.snapshot.profile ||
        current.snapshot.origin !== scoped.snapshot.origin
      ) {
        return capabilityDenied("forbidden");
      }
      lease.checkTarget(current.target);
      const inspected = inspectEvalResult(result.data.result);
      return inspected.ok
        ? controlOk({ result: result.data.result })
        : { ok: false, error: inspected.error };
    }),

    "POST /screenshot": withBody("screenshot", ScreenshotRequest, ["sessionId"], async (input, lease, signal) => {
      const scoped = targetForSession(lease.auditId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const shot = await deps.sessions.screenshotForOwner(lease.auditId, input.sessionId, signal);
      if (!shot.ok) return fromResult(shot);
      if (shot.data.png.byteLength > BROWSER_MAX_SCREENSHOT_BYTES) {
        return controlErr(
          "result_too_large",
          `screenshot exceeds ${BROWSER_MAX_SCREENSHOT_BYTES} bytes`,
        );
      }
      const current = targetForSession(lease.auditId, input.sessionId);
      if (!current.ok) return current.envelope;
      if (
        current.snapshot.navigationInFlight ||
        current.snapshot.generation !== scoped.snapshot.generation ||
        current.snapshot.origin !== scoped.snapshot.origin
      ) {
        return capabilityDenied("forbidden");
      }
      lease.checkTarget(current.target);
      if (signal?.aborted) return controlErr("cancelled", "screenshot request was cancelled");

      const resolvedShotsDir = resolve(deps.shotsDir);
      const path = resolve(screenshotFiles.makePath(resolvedShotsDir));
      if (dirname(path) !== resolvedShotsDir || !path.endsWith(".png")) {
        return controlErr("invalid", "screenshot destination escaped the server shots directory");
      }
      let wrote = false;
      try {
        await screenshotFiles.ensureDirectory(resolvedShotsDir);
        const writable = targetForSession(lease.auditId, input.sessionId);
        if (!writable.ok) return writable.envelope;
        if (writable.snapshot.generation !== scoped.snapshot.generation) {
          return capabilityDenied("forbidden");
        }
        lease.checkTarget(writable.target);
        if (signal?.aborted) return controlErr("cancelled", "screenshot request was cancelled");
        await screenshotFiles.writeExclusive(path, shot.data.png);
        wrote = true;
        const stillCurrent = targetForSession(lease.auditId, input.sessionId);
        if (
          signal?.aborted ||
          !stillCurrent.ok ||
          stillCurrent.snapshot.generation !== scoped.snapshot.generation
        ) {
          await screenshotFiles.remove(path);
          wrote = false;
          return signal?.aborted
            ? controlErr("cancelled", "screenshot request was cancelled")
            : capabilityDenied("forbidden");
        }
        lease.checkTarget(stillCurrent.target);
      } catch (error) {
        if (wrote) await screenshotFiles.remove(path).catch(() => undefined);
        return controlErr("failed", "screenshot persistence failed");
      }
      return controlOk({ path, bytes: shot.data.png.byteLength });
    }),

    "POST /close": withBody("close", CloseRequest, ["sessionId"], async (input, lease) => {
      const scoped = targetForSession(lease.auditId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const closed = deps.sessions.closeForOwner(lease.auditId, input.sessionId);
      if (!closed.ok) return fromResult(closed);
      const current = targetForSession(lease.auditId, input.sessionId);
      if (!current.ok || current.snapshot.generation !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      lease.checkTarget(current.target);
      lease.unbindGeneration(scoped.target.ref, scoped.snapshot.generation);
      return controlOk(closed.data);
    }),

    "POST /stop": withBody("stop", StopRequest, ["sessionId"], async (input, lease) => {
      const live = targetForSession(lease.auditId, input.sessionId);
      let snapshot: BrowserSessionAuthorizationSnapshot;
      if (live.ok) {
        snapshot = live.snapshot;
      } else {
        const stopped = deps.sessions.stoppedAuthorizationSnapshotForOwner(
          lease.auditId,
          input.sessionId,
        );
        if (!stopped.ok) return live.envelope;
        snapshot = stopped.data;
      }
      if (snapshot.origin === undefined) return capabilityDenied("forbidden");
      const exact = exactOrigins([snapshot.origin]);
      if (exact === undefined) return capabilityDenied("forbidden");
      const target: BrowserCapabilityUseTarget = {
        ref: snapshot.ref,
        hostId: snapshot.hostId,
        profile: snapshot.profile,
        exactOrigins: exact,
        ...(live.ok ? { generation: snapshot.generation } : {}),
      };
      lease.checkTarget(target);
      const boundGeneration = lease.boundGeneration(snapshot.ref);
      if (live.ok && boundGeneration !== snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const result = await deps.sessions.stopForOwner(lease.auditId, input.sessionId);
      if (!result.ok) return fromResult(result);
      if (boundGeneration === snapshot.generation) {
        lease.unbindGeneration(snapshot.ref, snapshot.generation);
      }
      return controlOk(result.data);
    }),

  };

  if (deps.stationBrowserWrapper !== undefined) {
    handlers["POST /station"] = route(
      null,
      async (body, _authorization, signal) => {
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("frame" in body) ||
          typeof body.frame !== "string" ||
          Buffer.byteLength(body.frame, "utf8") > STATION_BROWSER_MAX_FRAME_BYTES
        ) {
          return controlErr(
            "bad_request",
            "station browser request must contain one bounded frame",
          );
        }
        const responseFrame = await deps.stationBrowserWrapper!.handle(
          body.frame,
          signal,
        );
        const response = decodeStationBrowserResponse(responseFrame);
        return typeof response === "string"
          ? controlErr("forbidden", "station browser delegation was rejected")
          : controlOk({ frame: canonicalStationBrowserJson({
              ...response,
              data: response.ok ? response.data : null,
              error: response.ok ? null : response.error,
            }) });
      },
    );
  }

  return handlers;
};

const edgeGrantHttp = (
  denial: EdgeGrantDenial,
  message: string,
): { status: number; envelope: ControlEnvelope<never> } => {
  if (denial === "capacity") {
    return {
      status: 429,
      envelope: controlErr("resource_exhausted", message),
    };
  }
  if (
    denial === "peer_pid_unavailable" ||
    denial === "process_unbound" ||
    denial === "closed" ||
    denial === "canvas_unreadable" ||
    denial === "not_found"
  ) {
    return { status: 401, envelope: controlErr("unauthorized", message) };
  }
  return { status: 403, envelope: controlErr("forbidden", message) };
};

const stationOriginAdmissionHttp = (
  error: unknown,
): { readonly status: number; readonly envelope: ControlEnvelope<never> } => {
  if (error instanceof StationBrowserOriginAdmissionError) {
    if (
      error.denial === "peer_pid_unavailable" ||
      error.denial === "process_unbound" ||
      error.denial === "canvas_unreadable" ||
      error.denial === "not_found"
    ) {
      return {
        status: 401,
        envelope: controlErr(
          "unauthorized",
          "station browser origin admission failed",
        ),
      };
    }
    if (error.denial === "cancelled") {
      return {
        status: 408,
        envelope: controlErr(
          "cancelled",
          "station browser origin admission was cancelled",
        ),
      };
    }
    return {
      status: 403,
      envelope: controlErr(
        "forbidden",
        "station browser origin admission failed",
      ),
    };
  }
  return {
    status: 403,
    envelope: controlErr(
      "forbidden",
      "station browser origin admission failed",
    ),
  };
};

const stationRouterHttp = (
  error: unknown,
): { readonly status: number; readonly envelope: ControlEnvelope<never> } => {
  if (!(error instanceof StationBrowserRouterError)) {
    return {
      status: 500,
      envelope: controlErr("failed", "station browser route failed"),
    };
  }
  if (error.code === "cancelled") {
    return {
      status: 408,
      envelope: controlErr("cancelled", "station browser route was cancelled"),
    };
  }
  if (error.code === "admission") {
    return stationOriginAdmissionHttp(error.cause);
  }
  if (
    error.code === "invalid_route" ||
    error.code === "stale_page"
  ) {
    return {
      status: 400,
      envelope: controlErr("bad_request", "station browser route is stale or invalid"),
    };
  }
  if (
    error.code === "unknown_host" ||
    error.code === "host_capability" ||
    error.code === "wrong_host"
  ) {
    return {
      status: 403,
      envelope: controlErr("forbidden", "station browser route is not admitted"),
    };
  }
  return {
    status: 500,
    envelope: controlErr("failed", "station browser route failed"),
  };
};

/** Transport-free admit helpers for tests (product HTTP path always process-binds). */
export type ControlAdmitContext =
  | {
      readonly kind: "capability";
      readonly capability: string;
      readonly expectedPrincipal: BrowserAutomationPrincipal;
    }
  | { readonly kind: "principal"; readonly edgeGrant: EdgeGrantService; readonly principal: import("../process-identity").ProcessPrincipal };

/**
 * Full request dispatch (auth → route → handler), transport-free so tests
 * exercise exactly what the socket serves.
 *
 * Product HTTP path always process-binds first. Transport-free tests may pass
 * an admit context: `principal` (process principal → edge mint) or a
 * pre-minted capability secret (internal lease only — not client identity).
 */
export const dispatchControlRequest = async (
  handlers: ControlHandlers,
  token: string,
  request: {
    readonly method: string;
    readonly path: string;
    readonly token: string | undefined;
    readonly capability?: string;
    readonly requestId?: string;
    readonly body: unknown;
  },
  signal?: AbortSignal,
  admit?: ControlAdmitContext,
): Promise<{ status: number; envelope: ControlEnvelope<unknown> }> => {
  if (!tokenMatches(request.token, token)) {
    return { status: 401, envelope: controlErr("unauthorized", "missing or invalid token") };
  }
  if (
    !request.path.startsWith("/") ||
    request.path.startsWith("//") ||
    request.path.includes("?") ||
    request.path.includes("#")
  ) {
    return { status: 400, envelope: controlErr("bad_request", "invalid request target") };
  }
  const handler = handlers[`${request.method} ${request.path}`];
  if (!handler) {
    return {
      status: 404,
      envelope: controlErr("bad_request", "unknown route"),
    };
  }
  let authorization: ControlAuthorization | undefined;
  if (handler.action !== null) {
    let capability =
      admit?.kind === "capability" ? admit.capability : request.capability;
    let expectedPrincipal =
      admit?.kind === "capability" ? admit.expectedPrincipal : undefined;
    // Client-presented secrets are not identity. Only admit.principal mints
    // from a process principal, or a pre-minted internal lease is supplied.
    if (admit?.kind === "principal") {
      const edge = await admit.edgeGrant.admitPrincipal(admit.principal);
      if (!edge.ok) return edgeGrantHttp(edge.denial, edge.message);
      capability = edge.secret;
      expectedPrincipal = edge.expectedPrincipal;
    } else if (!isValidControlCapability(capability ?? "")) {
      return { status: 401, envelope: capabilityDenied("unauthorized") };
    }
    if (!isValidControlRequestId(request.requestId ?? "")) {
      return { status: 400, envelope: controlErr("bad_request", "invalid request id") };
    }
    const admitted = handler.preflight(capability, expectedPrincipal);
    if (!admitted.ok) {
      return {
        status: admitted.denial === "unauthorized" ? 401 : 403,
        envelope: capabilityDenied(admitted.denial),
      };
    }
    authorization = {
      capability: capability!,
      ...(expectedPrincipal === undefined ? {} : { expectedPrincipal }),
      requestId: request.requestId!,
    };
  }
  const envelope = await handler.run(request.body, authorization, signal);
  return { status: envelope.ok ? 200 : httpStatus(envelope.error._tag), envelope };
};

// ---------------------------------------------------------------------------
// HTTP hosting

type BodyReadResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: 400 | 408 | 413; readonly message: string };

const readBoundedBody = (req: IncomingMessage): Promise<BodyReadResult> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const settle = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      resolveBody(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > CONTROL_MAX_BODY_BYTES) {
        req.pause();
        settle({
          ok: false,
          status: 413,
          message: `request body exceeds ${CONTROL_MAX_BODY_BYTES} bytes`,
        });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        settle({ ok: true, body: undefined });
        return;
      }
      try {
        settle({ ok: true, body: JSON.parse(raw) });
      } catch {
        settle({ ok: false, status: 400, message: "body is not valid JSON" });
      }
    };
    const onAborted = (): void =>
      settle({ ok: false, status: 400, message: "request body was aborted" });
    const onError = (): void =>
      settle({ ok: false, status: 400, message: "request body could not be read" });
    const timer = setTimeout(() => {
      req.pause();
      settle({
        ok: false,
        status: 408,
        message: `request body was not received within ${CONTROL_REQUEST_TIMEOUT_MS}ms`,
      });
    }, CONTROL_REQUEST_TIMEOUT_MS);

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });

const transportToken = (req: IncomingMessage): string | undefined => {
  const header = req.headers[CONTROL_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  return undefined;
};

const fixedHeader = (req: IncomingMessage, name: string): string | undefined => {
  const header = req.headers[name];
  return typeof header === "string" ? header : undefined;
};

export interface BrowserControlServer {
  readonly socketPath: string;
  /** Synchronously refuses new requests and starts listener/socket teardown. */
  beginShutdown(): void;
  /** Bounded, retryable fixed-point drain for every admitted server resource. */
  drainOnQuit(): Promise<BrowserControlShutdownReceipt>;
  /** beginShutdown + drainOnQuit. Kept as the normal lifecycle entry point. */
  close(): Promise<BrowserControlShutdownReceipt>;
}

export interface BrowserControlRetainedCounts {
  readonly requests: number;
  readonly edgeAdmissions: number;
  readonly dispatches: number;
  readonly routeOperations: number;
  readonly listenerClosures: number;
  readonly sockets: number;
  readonly requestControllers: number;
  readonly socketPaths: number;
}

export interface BrowserControlShutdownReceipt {
  readonly clean: boolean;
  readonly rounds: number;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly retainedCounts: BrowserControlRetainedCounts;
  /** Unique resource classes still retained when the bounded drain returns. */
  readonly retainedLabels: ReadonlyArray<string>;
}

export interface BrowserControlRuntime {
  readonly chmodSocket: (path: string, mode: number) => void;
  /** Tests may lower, never raise, the production admission ceiling. */
  readonly maxActiveHandlers?: number;
  /** Tests may lower, never raise, the accepted peer ceiling. */
  readonly maxActiveClients?: number;
  /** Tests may lower, never raise, the production handler deadline. */
  readonly handlerTimeoutMs?: number;
  /** Tests may lower, never raise, the grace before server-side socket destroy. */
  readonly shutdownGraceMs?: number;
  /** Tests may lower, never raise, the complete shutdown drain deadline. */
  readonly shutdownDeadlineMs?: number;
}

const defaultControlRuntime: BrowserControlRuntime = {
  chmodSocket: chmodSync,
};

const BROWSER_CONTROL_SHUTDOWN_GRACE_MS = 100;
const BROWSER_CONTROL_SHUTDOWN_DEADLINE_MS = 2_000;
const BROWSER_CONTROL_MAX_CLIENTS = 32;

type BrowserControlFlightKind =
  | "request"
  | "edge-admission"
  | "dispatch"
  | "route-operation"
  | "listener-close"
  | "socket-close";

interface BrowserControlFlight {
  readonly id: number;
  readonly kind: BrowserControlFlightKind;
  readonly label: string;
  readonly promise: Promise<unknown>;
  status: "pending" | "fulfilled" | "rejected";
}

interface BrowserControlSocket {
  readonly id: number;
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, durationMs));

interface BrowserControlDeadline {
  readonly elapsed: Promise<void>;
  readonly hasElapsed: () => boolean;
  readonly cancel: () => void;
}

/** One process-timer deadline; never recomputed from the mutable wall clock. */
const startDeadline = (durationMs: number): BrowserControlDeadline => {
  let elapsed = false;
  let resolveElapsed!: () => void;
  const elapsedPromise = new Promise<void>((resolve) => {
    resolveElapsed = resolve;
  });
  const timer = setTimeout(() => {
    elapsed = true;
    resolveElapsed();
  }, durationMs);
  return Object.freeze({
    elapsed: elapsedPromise,
    hasElapsed: () => elapsed,
    cancel: () => clearTimeout(timer),
  });
};

const allSettledBefore = async (
  promises: ReadonlyArray<Promise<unknown>>,
  deadline: BrowserControlDeadline,
): Promise<
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly outcomes: ReadonlyArray<PromiseSettledResult<unknown>> }
> => {
  if (deadline.hasElapsed()) return { timedOut: true };
  return Promise.race([
    Promise.allSettled(promises).then((outcomes) => ({
      timedOut: false as const,
      outcomes,
    })),
    deadline.elapsed.then(() => ({ timedOut: true as const })),
  ]);
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });

const listenOnSocket = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

const parseContentLength = (
  req: IncomingMessage,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false } => {
  const header = req.headers["content-length"];
  if (header === undefined) return { ok: true, value: undefined };
  if (Array.isArray(header) || !/^(0|[1-9][0-9]*)$/.test(header)) return { ok: false };
  const value = Number(header);
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
};

export interface StationBrowserOriginControlRoute {
  readonly router: StationBrowserRouter;
  /**
   * Binds only the accepted owner-local socket. The returned port performs a
   * pre-body PID check and target-specific graph admission on every route.
   */
  readonly admissionForSocket: (socket: Socket) => StationBrowserRouteAdmission;
}

/**
 * Start the owner-local control plane. Idempotent per app run; call close() on
 * quit. The caller owns the capability registry so issuance and enforcement
 * cannot accidentally diverge. Startup resolves only after the Unix socket has
 * owner-only permissions.
 */
export const startBrowserControlServer = async (
  options: {
    readonly sessions: BrowserSessionService;
    readonly capabilities: BrowserCapabilityRegistry;
    readonly resolvePageTarget: PageTargetResolver;
    readonly version: string;
    readonly home?: string;
    /** Enables process-bind + edge admission without capability ceremony. */
    readonly readCanvas?: (name: string) => Promise<CanvasDoc | undefined>;
    readonly edgeGrant?: EdgeGrantService;
    readonly stationBrowserWrapper?: StationBrowserWrapper;
    readonly stationBrowserOrigin?: StationBrowserOriginControlRoute;
  },
  runtime: BrowserControlRuntime = defaultControlRuntime,
): Promise<BrowserControlServer> => {
  const home = options.home ?? homedir();
  const dir = controlDir(home);
  prepareControlDirectory(dir);
  await ensureScreenshotDirectory(controlShotsDir(home));

  let token = "";
  const canvasesDir = join(home, ".vellum", "canvases");
  const edgeGrant =
    options.edgeGrant ??
    makeEdgeGrantService({
      capabilities: options.capabilities,
      canvasesDir,
      resolvePageTarget: options.resolvePageTarget,
      station: () => options.sessions.stationIdentity(),
      admitBrowserHost: (hostId) => options.sessions.admitAutomationHost(hostId),
      ...(options.readCanvas === undefined ? {} : { readCanvas: options.readCanvas }),
    });
  const maxActiveHandlers = boundedRuntimeValue(
    runtime.maxActiveHandlers,
    BROWSER_MAX_ACTIVE_HTTP_HANDLERS,
  );
  const maxActiveClients = boundedRuntimeValue(
    runtime.maxActiveClients,
    BROWSER_CONTROL_MAX_CLIENTS,
  );
  const handlerTimeoutMs = boundedRuntimeValue(
    runtime.handlerTimeoutMs,
    BROWSER_CONTROL_HANDLER_TIMEOUT_MS,
  );
  const shutdownGraceMs = boundedRuntimeValue(
    runtime.shutdownGraceMs,
    BROWSER_CONTROL_SHUTDOWN_GRACE_MS,
  );
  const shutdownDeadlineMs = boundedRuntimeValue(
    runtime.shutdownDeadlineMs,
    BROWSER_CONTROL_SHUTDOWN_DEADLINE_MS,
  );
  let activeHandlers = 0;
  let shuttingDown = false;
  let nextFlightId = 0;
  let nextControllerId = 0;
  let nextSocketId = 0;
  let listenerCloseFlight: Promise<void> | undefined;
  let drainFlight: Promise<BrowserControlShutdownReceipt> | undefined;
  const activeFlights = new Map<number, BrowserControlFlight>();
  const shutdownJournal = new Map<number, BrowserControlFlight>();
  const requestControllers = new Map<number, AbortController>();
  const sockets = new Map<number, BrowserControlSocket>();
  const admittedClients = new Set<Socket>();

  const retainFlight = <A>(
    kind: BrowserControlFlightKind,
    label: string,
    promise: Promise<A>,
  ): Promise<A> => {
    const flight: BrowserControlFlight = {
      id: ++nextFlightId,
      kind,
      label,
      promise,
      status: "pending",
    };
    activeFlights.set(flight.id, flight);
    if (shuttingDown) shutdownJournal.set(flight.id, flight);
    void promise.then(
      () => {
        flight.status = "fulfilled";
        activeFlights.delete(flight.id);
      },
      () => {
        flight.status = "rejected";
        activeFlights.delete(flight.id);
      },
    );
    return promise;
  };

  const handlers = makeControlHandlers({
    sessions: options.sessions,
    capabilities: options.capabilities,
    resolvePageTarget: options.resolvePageTarget,
    version: options.version,
    canvasesDir,
    shotsDir: controlShotsDir(home),
    edgeGrant,
    ...(options.stationBrowserWrapper === undefined
      ? {}
      : { stationBrowserWrapper: options.stationBrowserWrapper }),
    retainRouteOperation: (action, operation) =>
      retainFlight("route-operation", `route:${action}`, operation),
  });

  const server: Server = createServer(
    { maxHeaderSize: CONTROL_MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      // This is the first request admission gate. It intentionally precedes
      // token checks and process/edge admission so shutdown cannot begin a new
      // filesystem scan or capability mint through an already-accepted peer.
      // Node's HTTP parser is downstream of the raw connection event, but an
      // excess peer may already have request bytes buffered when the client
      // ceiling rejects it. Never let such a peer reach any HTTP route.
      if (shuttingDown || !admittedClients.has(req.socket)) {
        res.destroy();
        return;
      }
      const controllerId = ++nextControllerId;
      const controller = new AbortController();
      requestControllers.set(controllerId, controller);
      const requestFlight = (async () => {
        const respond = (
          status: number,
          envelope: ControlEnvelope<unknown>,
          closeConnection = false,
        ): void => {
          if (res.headersSent || res.destroyed) return;
          const inspected = inspectControlJson(envelope, BROWSER_CONTROL_MAX_RESPONSE_BYTES);
          const safeEnvelope: ControlEnvelope<unknown> = inspected.ok
            ? envelope
            : { ok: false, error: inspected.error };
          const safeStatus = inspected.ok ? status : httpStatus(inspected.error._tag);
          const body = inspected.ok ? inspected.encoded : encodeControlEnvelope(safeEnvelope);
          res.writeHead(safeStatus, {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            ...(closeConnection ? { connection: "close" } : {}),
          });
          if (closeConnection) {
            res.once("finish", () => req.socket.destroy());
          }
          res.end(body);
        };

        const presentedToken = transportToken(req);
        if (!tokenMatches(presentedToken, token)) {
          respond(401, controlErr("unauthorized", "missing or invalid token"), true);
          return;
        }

        const rawTarget = req.url ?? "/";
        if (
          !rawTarget.startsWith("/") ||
          rawTarget.startsWith("//") ||
          rawTarget.includes("?") ||
          rawTarget.includes("#")
        ) {
          respond(400, controlErr("bad_request", "invalid request target"), true);
          return;
        }
        const method = req.method ?? "GET";
        const isStationOriginRoute =
          method === "POST" &&
          rawTarget === STATION_BROWSER_ORIGIN_ROUTE_PATH &&
          options.stationBrowserOrigin !== undefined;
        const handler = handlers[`${method} ${rawTarget}`];
        if (handler === undefined && !isStationOriginRoute) {
          respond(404, controlErr("bad_request", "unknown route"), true);
          return;
        }
        const presentedRequestId = fixedHeader(req, CONTROL_REQUEST_ID_HEADER);
        // Protected routes: process-bind only (peer PID → edges). Client
        // capability secrets are not identity — edge-grant mints an internal
        // lease after process admission.
        let processAdmission:
          | {
              readonly capability: string;
              readonly expectedPrincipal: BrowserAutomationPrincipal;
            }
          | undefined;
        let stationRouteAdmission: StationBrowserRouteAdmission | undefined;
        if (isStationOriginRoute) {
          try {
            stationRouteAdmission =
              options.stationBrowserOrigin!.admissionForSocket(req.socket);
            await retainFlight(
              "edge-admission",
              "station-origin-preflight",
              stationRouteAdmission.preflight(controller.signal),
            );
          } catch (error) {
            const denied = stationOriginAdmissionHttp(error);
            respond(denied.status, denied.envelope, true);
            return;
          }
          if (shuttingDown || controller.signal.aborted) return;
          if (!isValidControlRequestId(presentedRequestId ?? "")) {
            respond(400, controlErr("bad_request", "invalid request id"), true);
            return;
          }
        } else if (handler!.action !== null) {
          const edge = await retainFlight(
            "edge-admission",
            "edge-admission",
            edgeGrant.admitSocket(req.socket),
          );
          if (shuttingDown || controller.signal.aborted) {
            // An admission that crossed the shutdown boundary never reaches a
            // route, even if its underlying process/canvas lookup ignored the
            // request abort signal.
            edgeGrant.clear();
            return;
          }
          if (!edge.ok) {
            const denied = edgeGrantHttp(edge.denial, edge.message);
            respond(denied.status, denied.envelope, true);
            return;
          }
          processAdmission = {
            capability: edge.secret,
            expectedPrincipal: edge.expectedPrincipal,
          };
          const admitted = handler!.preflight(
            processAdmission.capability,
            processAdmission.expectedPrincipal,
          );
          if (!admitted.ok) {
            respond(
              admitted.denial === "unauthorized" ? 401 : 403,
              capabilityDenied(admitted.denial),
              true,
            );
            return;
          }
          // Request ids and bodies are protected-route protocol details. Do
          // not validate or disclose them until Unix peer process-bind and
          // edge-scoped capability admission have both succeeded.
          if (!isValidControlRequestId(presentedRequestId ?? "")) {
            respond(400, controlErr("bad_request", "invalid request id"), true);
            return;
          }
        }
        if (activeHandlers >= maxActiveHandlers) {
          respond(
            429,
            controlErr(
              "resource_exhausted",
              `active browser handler capacity reached (${maxActiveHandlers})`,
            ),
            true,
          );
          return;
        }

        activeHandlers += 1;
        let deadlineExpired = false;
        const abortDisconnected = (): void => {
          if (!res.writableEnded && !controller.signal.aborted) controller.abort();
        };
        req.once("aborted", abortDisconnected);
        res.once("close", abortDisconnected);
        const deadline = setTimeout(() => {
          deadlineExpired = true;
          if (!controller.signal.aborted) controller.abort();
        }, handlerTimeoutMs);
        let handlerReleased = false;
        const releaseHandler = (): void => {
          if (handlerReleased) return;
          handlerReleased = true;
          activeHandlers -= 1;
        };

        try {
          const dispatchOperation = (async (): Promise<{
            readonly status: number;
            readonly envelope: ControlEnvelope<unknown>;
            readonly closeConnection?: boolean;
          }> => {
            const declaredLength = parseContentLength(req);
            if (!declaredLength.ok) {
              return {
                status: 400,
                envelope: controlErr("bad_request", "invalid Content-Length header"),
                closeConnection: true,
              };
            }
            if (
              declaredLength.value !== undefined &&
              declaredLength.value > CONTROL_MAX_BODY_BYTES
            ) {
              return {
                status: 413,
                envelope: controlErr(
                  "bad_request",
                  `request body exceeds ${CONTROL_MAX_BODY_BYTES} bytes`,
                ),
                closeConnection: true,
              };
            }

            const body = await readBoundedBody(req);
            if (!body.ok) {
              return {
                status: body.status,
                envelope: controlErr("bad_request", body.message),
                closeConnection: true,
              };
            }
            if (isStationOriginRoute) {
              const decoded = decodeStationBrowserRouteInput(body.body);
              if (!decoded.ok || stationRouteAdmission === undefined) {
                return {
                  status: 400,
                  envelope: controlErr(
                    "bad_request",
                    "station browser route body is invalid",
                  ),
                  closeConnection: true,
                };
              }
              try {
                const response: StationBrowserResponse = await retainFlight(
                  "route-operation",
                  `station-route:${decoded.input.action}`,
                  options.stationBrowserOrigin!.router.route(
                    stationRouteAdmission,
                    decoded.input,
                    controller.signal,
                  ),
                );
                return {
                  status: 200,
                  envelope: controlOk({ response }),
                };
              } catch (error) {
                const denied = stationRouterHttp(error);
                return {
                  status: denied.status,
                  envelope: denied.envelope,
                  closeConnection: denied.status === 401,
                };
              }
            }
            return dispatchControlRequest(
              handlers,
              token,
              {
                method,
                path: rawTarget,
                token: presentedToken,
                ...(presentedRequestId === undefined
                  ? {}
                  : { requestId: presentedRequestId }),
                body: body.body,
              },
              controller.signal,
              processAdmission === undefined
                ? undefined
                : {
                    kind: "capability",
                    capability: processAdmission.capability,
                    expectedPrincipal: processAdmission.expectedPrincipal,
                  },
            );
          })().catch((_error: unknown) => ({
            status: 500,
            envelope: controlErr("failed", "browser control operation failed"),
            closeConnection: false,
          }));
          const operation = retainFlight("dispatch", "dispatch", dispatchOperation);

          const aborted = new Promise<{ readonly aborted: true }>((resolveAbort) => {
            if (controller.signal.aborted) {
              resolveAbort({ aborted: true });
              return;
            }
            controller.signal.addEventListener(
              "abort",
              () => resolveAbort({ aborted: true }),
              { once: true },
            );
          });
          const outcome = await Promise.race([
            operation.then((reply) => ({ aborted: false as const, reply })),
            aborted,
          ]);
          if (deadlineExpired) {
            respond(
              504,
              controlErr("timeout", `browser control handler exceeded ${handlerTimeoutMs}ms`),
              true,
            );
            return;
          }
          if (outcome.aborted) {
            return;
          }
          respond(
            outcome.reply.status,
            outcome.reply.envelope,
            outcome.reply.closeConnection ?? false,
          );
        } finally {
          clearTimeout(deadline);
          req.off("aborted", abortDisconnected);
          res.off("close", abortDisconnected);
          releaseHandler();
        }
      })();
      void requestFlight.then(
        () => requestControllers.delete(controllerId),
        () => {
          requestControllers.delete(controllerId);
          if (!res.destroyed) res.destroy();
        },
      );
      void retainFlight("request", "request", requestFlight);
    },
  );
  server.headersTimeout = CONTROL_HEADERS_TIMEOUT_MS;
  server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  server.on("connection", (socket: Socket) => {
    if (shuttingDown || admittedClients.size >= maxActiveClients) {
      socket.destroy();
      return;
    }
    admittedClients.add(socket);
    const id = ++nextSocketId;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveSocketClosed) => {
      resolveClosed = resolveSocketClosed;
    });
    const record: BrowserControlSocket = { id, socket, closed };
    sockets.set(id, record);
    void retainFlight("socket-close", "socket", closed);
    socket.once("close", () => {
      admittedClients.delete(socket);
      sockets.delete(id);
      resolveClosed();
    });
    if (shuttingDown) socket.end();
  });
  server.on("clientError", (error: Error & { code?: string }, socket) => {
    if (!socket.writable) return;
    const status =
      error.code === "HPE_HEADER_OVERFLOW"
        ? 431
        : error.code === "ERR_HTTP_REQUEST_TIMEOUT"
          ? 408
          : 400;
    const envelope = controlErr(
      "bad_request",
      status === 431 ? "request headers exceed the admission limit" : "malformed request",
    );
    const body = encodeControlEnvelope(envelope);
    socket.end(
      `HTTP/1.1 ${status} ${status === 431 ? "Request Header Fields Too Large" : "Bad Request"}\r\n` +
        "Content-Type: application/json\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  });

  // Stale socket from a crashed run blocks listen — remove before binding.
  const socketPath = controlSocketPath(home);
  const listenerLease = await acquireControlListenerLease(socketPath);
  try {
    token = rotateControlToken(controlTokenPath(home));
    await removeObservedSocket(listenerLease);
    await listenOnSocket(server, socketPath);
  } catch (error) {
    await releaseControlListenerLease(listenerLease);
    throw error;
  }
  let socketIdentity: ControlSocketPathIdentity | undefined;
  let socketPathCleanupBlocked = false;
  /** Exact bound inode still at the pathname — independent of a live kernel lease. */
  const pathMatchesCapturedIdentity = (): boolean => {
    if (socketIdentity === undefined) return false;
    try {
      const current = lstatSync(socketPath, { bigint: true });
      return (
        current.isSocket() &&
        !current.isSymbolicLink() &&
        current.dev === socketIdentity.dev &&
        current.ino === socketIdentity.ino &&
        current.birthtimeNs === socketIdentity.birthtimeNs &&
        current.uid === socketIdentity.uid
      );
    } catch {
      return false;
    }
  };
  const unlinkOwnedSocket = (): void => {
    if (
      socketIdentity !== undefined &&
      controlListenerLeaseHeld(listenerLease)
    ) {
      removeOwnedControlSocketPath(listenerLease, socketIdentity);
      return;
    }
    if (pathMatchesCapturedIdentity()) {
      unlinkSync(socketPath);
    }
  };
  const closeListenerWithoutDeletingReplacement = async (): Promise<void> => {
    if (existsSync(socketPath) && !pathMatchesCapturedIdentity()) {
      // Node/libuv unlinks the originally-bound pathname during Server.close,
      // even if another process replaced that directory entry. There is no
      // identity-checked unlink primitive in Node, so refuse the close rather
      // than trying to preserve/restore a foreign path across a TOCTOU window.
      // Identity is lease-independent so Ctrl+C killing Darwin lockf still
      // allows close of the exact inode we bound.
      socketPathCleanupBlocked = true;
      server.unref();
      throw new Error("refusing to close browser listener over a replacement path");
    }
    await closeServer(server);
    try {
      unlinkOwnedSocket();
      socketPathCleanupBlocked = false;
    } finally {
      if (controlListenerLeaseHeld(listenerLease)) {
        await releaseControlListenerLease(listenerLease);
      }
    }
  };
  const ensureListenerClose = (): void => {
    if (
      (!server.listening && !controlListenerLeaseHeld(listenerLease)) ||
      listenerCloseFlight !== undefined
    ) return;
    const close = closeListenerWithoutDeletingReplacement();
    listenerCloseFlight = close;
    void retainFlight("listener-close", "listener", close);
    void close.then(
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
      () => {
        if (listenerCloseFlight === close) listenerCloseFlight = undefined;
      },
    );
  };
  try {
    // Capture before invoking the chmod seam: a failing implementation must
    // not replace the path and trick cleanup into deleting a foreign file.
    socketIdentity = captureControlSocketPathIdentity(listenerLease);
  } catch (error) {
    await closeListenerWithoutDeletingReplacement().catch(() => undefined);
    throw error;
  }
  try {
    runtime.chmodSocket(socketPath, 0o600);
    const hardened = lstatSync(socketPath, { bigint: true });
    if (
      !hardened.isSocket() ||
      !controlSocketPathOwnedByLease(listenerLease, socketIdentity)
    ) {
      throw new Error("browser control socket identity changed during permission hardening");
    }
    // Publish the hardened identity only after the original inode/birth
    // witness has remained stable.
    socketIdentity = Object.freeze({
      dev: hardened.dev,
      ino: hardened.ino,
      birthtimeNs: hardened.birthtimeNs,
      uid: hardened.uid,
    });
  } catch (error) {
    await closeListenerWithoutDeletingReplacement().catch(() => undefined);
    throw error;
  }
  server.on("error", (error) => {
    console.error("[browser-control] server error:", error);
  });

  const beginShutdown = (): void => {
    if (shuttingDown) return;
    // The state flip is first and synchronous. Request callbacks, including
    // process/edge admission, observe it before doing any async work.
    shuttingDown = true;
    for (const flight of activeFlights.values()) {
      shutdownJournal.set(flight.id, flight);
    }
    try {
      edgeGrant.clear();
    } catch {
      // Admission is already closed; cache cleanup remains best-effort.
    }
    for (const controller of requestControllers.values()) {
      if (!controller.signal.aborted) controller.abort("browser control shutdown");
    }
    try {
      unlinkOwnedSocket();
    } catch {
      // The bounded receipt reports a retained path and retries the unlink.
    }
    ensureListenerClose();
    // Graceful half-close first. drainOnQuit applies a bounded destroy after
    // the configured grace; no peer PID is ever signalled.
    for (const { socket } of sockets.values()) {
      if (!socket.destroyed) socket.end();
    }
  };

  const retainedSnapshot = (): {
    readonly counts: BrowserControlRetainedCounts;
    readonly labels: ReadonlyArray<string>;
  } => {
    const pending = [...shutdownJournal.values()].filter(
      (flight) => flight.status === "pending",
    );
    const countKind = (kind: BrowserControlFlightKind): number =>
      pending.filter((flight) => flight.kind === kind).length;
    const listenerClosures = Math.max(
      countKind("listener-close"),
      server.listening || controlListenerLeaseHeld(listenerLease) ? 1 : 0,
    );
    const socketPaths = pathMatchesCapturedIdentity() || socketPathCleanupBlocked ? 1 : 0;
    const counts: BrowserControlRetainedCounts = {
      requests: countKind("request"),
      edgeAdmissions: countKind("edge-admission"),
      dispatches: countKind("dispatch"),
      routeOperations: countKind("route-operation"),
      listenerClosures,
      sockets: sockets.size,
      requestControllers: requestControllers.size,
      socketPaths,
    };
    const labels = new Set(
      pending
        .filter((flight) => flight.kind !== "socket-close")
        .map((flight) => flight.label),
    );
    if (sockets.size > 0) labels.add("socket");
    if (requestControllers.size > 0) labels.add("request-controller");
    if (server.listening || controlListenerLeaseHeld(listenerLease)) labels.add("listener");
    if (socketPaths > 0) labels.add("socket-path");
    return { counts, labels: [...labels].sort() };
  };

  const runDrain = async (
    deadline: BrowserControlDeadline,
  ): Promise<BrowserControlShutdownReceipt> => {
    let rounds = 0;
    let settled = 0;
    let fulfilled = 0;
    let rejected = 0;

    const gracefulSocketFlights = [...sockets.values()].map((entry) => entry.closed);
    if (gracefulSocketFlights.length > 0) {
      const graceDeadline = startDeadline(
        Math.min(shutdownGraceMs, shutdownDeadlineMs),
      );
      try {
        await Promise.race([
          Promise.allSettled(gracefulSocketFlights),
          graceDeadline.elapsed,
          deadline.elapsed,
        ]);
      } finally {
        graceDeadline.cancel();
      }
    }
    for (const { socket } of sockets.values()) {
      if (!socket.destroyed) socket.destroy();
    }

    for (;;) {
      for (const controller of requestControllers.values()) {
        if (!controller.signal.aborted) controller.abort("browser control shutdown");
      }
      for (const { socket } of sockets.values()) {
        if (!socket.destroyed) socket.destroy();
      }
      try {
        unlinkOwnedSocket();
      } catch {
        // Retained in the explicit deadline receipt below.
      }

      const round = [...shutdownJournal.values()];
      if (round.length > 0) {
        const outcome = await allSettledBefore(
          round.map((flight) => flight.promise),
          deadline,
        );
        if (outcome.timedOut) break;
        rounds += 1;
        settled += outcome.outcomes.length;
        fulfilled += outcome.outcomes.filter((entry) => entry.status === "fulfilled").length;
        rejected += outcome.outcomes.filter((entry) => entry.status === "rejected").length;
        for (const flight of round) shutdownJournal.delete(flight.id);
        // Give close/finally callbacks one event-loop turn to publish any
        // nested flight before deciding the fixed point is empty.
        await Promise.race([
          new Promise<void>((resolveTurn) => setImmediate(resolveTurn)),
          deadline.elapsed,
        ]);
        continue;
      }

      const retained = retainedSnapshot();
      const clean = Object.values(retained.counts).every((count) => count === 0);
      if (clean) {
        return Object.freeze({
          clean: true,
          rounds,
          settled,
          fulfilled,
          rejected,
          retainedCounts: Object.freeze(retained.counts),
          retainedLabels: Object.freeze(retained.labels),
        });
      }
      if (deadline.hasElapsed()) break;
      await Promise.race([wait(5), deadline.elapsed]);
    }

    // If the deadline raced a just-settled batch, observe that batch through
    // allSettled before producing the final receipt. Pending records remain
    // strongly retained and are reported below for a retry.
    const settledAtDeadline = [...shutdownJournal.values()].filter(
      (flight) => flight.status !== "pending",
    );
    if (settledAtDeadline.length > 0) {
      const outcomes = await Promise.allSettled(
        settledAtDeadline.map((flight) => flight.promise),
      );
      rounds += 1;
      settled += outcomes.length;
      fulfilled += outcomes.filter((entry) => entry.status === "fulfilled").length;
      rejected += outcomes.filter((entry) => entry.status === "rejected").length;
      for (const flight of settledAtDeadline) shutdownJournal.delete(flight.id);
    }
    const retained = retainedSnapshot();
    const clean = Object.values(retained.counts).every((count) => count === 0);
    return Object.freeze({
      clean,
      rounds,
      settled,
      fulfilled,
      rejected,
      retainedCounts: Object.freeze(retained.counts),
      retainedLabels: Object.freeze(retained.labels),
    });
  };

  const drainOnQuit = (): Promise<BrowserControlShutdownReceipt> => {
    if (drainFlight !== undefined) return drainFlight;

    let resolveDrain!: (receipt: BrowserControlShutdownReceipt) => void;
    let rejectDrain!: (error: unknown) => void;
    const publishedDrain = new Promise<BrowserControlShutdownReceipt>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });
    // Publish before beginShutdown: edgeGrant.clear(), AbortController
    // listeners, Server.close(), and socket.end() are all callback seams that
    // may reenter drainOnQuit synchronously.
    drainFlight = publishedDrain;
    void publishedDrain.then(
      () => {
        if (drainFlight === publishedDrain) drainFlight = undefined;
      },
      () => {
        if (drainFlight === publishedDrain) drainFlight = undefined;
      },
    );

    const deadline = startDeadline(shutdownDeadlineMs);
    try {
      beginShutdown();
      // A previous bounded attempt may have refused a destructive close over a
      // replacement path. Retry once per explicit drain.
      ensureListenerClose();
      void runDrain(deadline).then(
        (receipt) => {
          deadline.cancel();
          resolveDrain(receipt);
        },
        (error) => {
          deadline.cancel();
          rejectDrain(error);
        },
      );
    } catch (error) {
      deadline.cancel();
      rejectDrain(error);
    }
    return publishedDrain;
  };

  return {
    socketPath,
    beginShutdown,
    drainOnQuit,
    close: drainOnQuit,
  };
};
