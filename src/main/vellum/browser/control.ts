import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
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
  type ControlEnvelope,
  type ControlErrorTag,
  type PageNodeRow,
} from "@shared/browser-control";
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
import type { BrowserResult } from "./sessions";
import { BROWSER_UI_SESSION_OWNER, BrowserSessionService } from "./sessions";
import type { PageTargetResolver } from "./page-target";
import type { ResolvedPageTarget } from "./page-target";
import {
  BrowserCapabilityDenied,
  BrowserCapabilityRegistry,
  BrowserCapabilityStateDenied,
  makeBrowserCapabilityRegistry,
  type BrowserCapabilityAction,
  type BrowserCapabilityCompletionOutcome,
  type BrowserCapabilityLease,
  type BrowserCapabilityPreflightResult,
  type BrowserCapabilityTarget,
  type BrowserCapabilityUseTarget,
} from "./capabilities";

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
  const token = randomBytes(32).toString("hex");
  const temporaryPath = `${tokenPath}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, `${token}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, tokenPath);
    chmodSync(tokenPath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return token;
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
                : tag === "unsupported_result"
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
  readonly requestId: string;
}

interface ControlRouteHandler {
  readonly action: BrowserCapabilityAction | null;
  readonly preflight: (capability: string | undefined) => BrowserCapabilityPreflightResult;
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
      allowed.profile === target.profile &&
      target.exactOrigins.every((origin) => allowed.exactOrigins.includes(origin)),
  );

const sameResolvedTarget = (
  left: ResolvedPageTarget,
  right: ResolvedPageTarget,
): boolean =>
  left.ref === right.ref &&
  left.nodeId === right.nodeId &&
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
        { requestId: authorization.requestId },
      );
    } catch (error) {
      return capabilityError(error);
    }
    const combined = combineAbortSignals(requestSignal, lease.signal);
    let outcome: BrowserCapabilityCompletionOutcome = "failed";
    try {
      if (combined.signal.aborted) {
        outcome = "cancelled";
        return controlErr("cancelled", "browser control request was cancelled");
      }
      const envelope = await run(lease, combined.signal);
      outcome = releaseOutcome(envelope);
      return envelope;
    } catch (error) {
      if (combined.signal.aborted) {
        outcome = "cancelled";
        return controlErr("cancelled", "browser control request was cancelled");
      }
      return capabilityError(error);
    } finally {
      combined.dispose();
      lease.release(outcome);
    }
  };

  const route = (
    action: BrowserCapabilityAction | null,
    run: ControlRouteHandler["run"],
  ): ControlRouteHandler => ({
    action,
    preflight: (capability) =>
      action === null
        ? { ok: true }
        : deps.capabilities.preflight(capability, action),
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
      const result = deps.sessions.listForOwner(lease.ownerId);
      if (!result.ok) return fromResult(result);
      const filtered = result.data.filter((session) => {
        if (signal.aborted) return false;
        const scoped = targetForSession(lease.ownerId, session.sessionId);
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
        lease.ownerId,
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
          const current = targetForSession(lease.ownerId, row.sessionId);
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

      const opened = await deps.sessions.openForOwner(lease.ownerId, resolved.data, signal);
      if (!opened.ok) {
        deps.sessions.destroyOwnerSessions(lease.ownerId, "browser open failed closed");
        return fromResult(opened);
      }
      const failOpen = <A>(envelope: ControlEnvelope<A>): ControlEnvelope<A> => {
        deps.sessions.destroyOwnerSessions(lease.ownerId, "browser open authorization failed");
        return envelope;
      };

      try {
        const terminal = await deps.sessions.awaitNavigationTerminalForOwner(
          lease.ownerId,
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
          lease.ownerId,
          terminal.data.sessionId,
        );
        if (
          !current.ok ||
          current.data.ref !== resolved.data.ref ||
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
          lease.ownerId,
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
        deps.sessions.destroyOwnerSessions(lease.ownerId, "browser open authorization failed");
        throw error;
      }
    }),

    "POST /goto": withBody("goto", GotoRequest, ["sessionId", "url"], async (input, lease, signal) => {
      const scoped = targetForSession(lease.ownerId, input.sessionId, [input.url]);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const destinationOrigin = exactHttpOrigin(input.url);
      if (destinationOrigin === undefined) return capabilityDenied("forbidden");

      const navigated = deps.sessions.gotoForOwner(lease.ownerId, input.sessionId, input.url, signal);
      if (!navigated.ok) return fromResult(navigated);
      if (navigated.data.sessionId !== scoped.snapshot.generation) {
        lease.rollGeneration(
          scoped.target.ref,
          scoped.snapshot.generation,
          navigated.data.sessionId,
        );
      }
      const terminal = await deps.sessions.awaitNavigationTerminalForOwner(
        lease.ownerId,
        navigated.data.sessionId,
        signal,
      );
      if (!terminal.ok) return fromResult(terminal);
      const current = deps.sessions.authorizationSnapshotForOwner(
        lease.ownerId,
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
      const scoped = targetForSession(lease.ownerId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const result = await deps.sessions.evalForOwner(lease.ownerId, input.sessionId, input.code, signal);
      if (!result.ok) return fromResult(result);
      const current = targetForSession(lease.ownerId, input.sessionId);
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
      const scoped = targetForSession(lease.ownerId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const shot = await deps.sessions.screenshotForOwner(lease.ownerId, input.sessionId, signal);
      if (!shot.ok) return fromResult(shot);
      if (shot.data.png.byteLength > BROWSER_MAX_SCREENSHOT_BYTES) {
        return controlErr(
          "result_too_large",
          `screenshot exceeds ${BROWSER_MAX_SCREENSHOT_BYTES} bytes`,
        );
      }
      const current = targetForSession(lease.ownerId, input.sessionId);
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
        const writable = targetForSession(lease.ownerId, input.sessionId);
        if (!writable.ok) return writable.envelope;
        if (writable.snapshot.generation !== scoped.snapshot.generation) {
          return capabilityDenied("forbidden");
        }
        lease.checkTarget(writable.target);
        if (signal?.aborted) return controlErr("cancelled", "screenshot request was cancelled");
        await screenshotFiles.writeExclusive(path, shot.data.png);
        wrote = true;
        const stillCurrent = targetForSession(lease.ownerId, input.sessionId);
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
      const scoped = targetForSession(lease.ownerId, input.sessionId);
      if (!scoped.ok) return scoped.envelope;
      lease.checkTarget(scoped.target);
      if (lease.boundGeneration(scoped.target.ref) !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      const closed = deps.sessions.closeForOwner(lease.ownerId, input.sessionId);
      if (!closed.ok) return fromResult(closed);
      const current = targetForSession(lease.ownerId, input.sessionId);
      if (!current.ok || current.snapshot.generation !== scoped.snapshot.generation) {
        return capabilityDenied("forbidden");
      }
      lease.checkTarget(current.target);
      lease.unbindGeneration(scoped.target.ref, scoped.snapshot.generation);
      return controlOk(closed.data);
    }),
  };

  return handlers;
};

/**
 * Full request dispatch (auth → route → handler), transport-free so tests
 * exercise exactly what the socket serves.
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
    if (!isValidControlCapability(request.capability ?? "")) {
      return { status: 401, envelope: capabilityDenied("unauthorized") };
    }
    if (!isValidControlRequestId(request.requestId ?? "")) {
      return { status: 400, envelope: controlErr("bad_request", "invalid request id") };
    }
    const admitted = handler.preflight(request.capability);
    if (!admitted.ok) {
      return {
        status: admitted.denial === "unauthorized" ? 401 : 403,
        envelope: capabilityDenied(admitted.denial),
      };
    }
    authorization = {
      capability: request.capability!,
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
  close(): void;
}

export interface BrowserControlRuntime {
  readonly chmodSocket: (path: string, mode: number) => void;
  /** Tests may lower, never raise, the production admission ceiling. */
  readonly maxActiveHandlers?: number;
  /** Tests may lower, never raise, the production handler deadline. */
  readonly handlerTimeoutMs?: number;
}

const defaultControlRuntime: BrowserControlRuntime = {
  chmodSocket: chmodSync,
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });

const unlinkSocket = (socketPath: string): void => {
  if (existsSync(socketPath)) unlinkSync(socketPath);
};

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

/**
 * Start the owner-local control plane. Idempotent per app run; call close() on
 * quit. Startup resolves only after the Unix socket has owner-only permissions.
 */
export const startBrowserControlServer = async (
  options: {
    readonly sessions: BrowserSessionService;
    readonly capabilities?: BrowserCapabilityRegistry;
    readonly resolvePageTarget: PageTargetResolver;
    readonly version: string;
    readonly home?: string;
  },
  runtime: BrowserControlRuntime = defaultControlRuntime,
): Promise<BrowserControlServer> => {
  const home = options.home ?? homedir();
  const dir = controlDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  await ensureScreenshotDirectory(controlShotsDir(home));

  const token = rotateControlToken(controlTokenPath(home));
  const capabilities = options.capabilities ?? makeBrowserCapabilityRegistry();
  const ownsCapabilities = options.capabilities === undefined;
  const handlers = makeControlHandlers({
    sessions: options.sessions,
    capabilities,
    resolvePageTarget: options.resolvePageTarget,
    version: options.version,
    canvasesDir: join(home, ".vellum", "canvases"),
    shotsDir: controlShotsDir(home),
  });
  const maxActiveHandlers = boundedRuntimeValue(
    runtime.maxActiveHandlers,
    BROWSER_MAX_ACTIVE_HTTP_HANDLERS,
  );
  const handlerTimeoutMs = boundedRuntimeValue(
    runtime.handlerTimeoutMs,
    BROWSER_CONTROL_HANDLER_TIMEOUT_MS,
  );
  let activeHandlers = 0;

  const server: Server = createServer(
    { maxHeaderSize: CONTROL_MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
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
        const handler = handlers[`${method} ${rawTarget}`];
        if (handler === undefined) {
          respond(404, controlErr("bad_request", "unknown route"), true);
          return;
        }
        const presentedCapability = fixedHeader(req, CONTROL_CAPABILITY_HEADER);
        const presentedRequestId = fixedHeader(req, CONTROL_REQUEST_ID_HEADER);
        if (handler.action !== null) {
          if (!isValidControlCapability(presentedCapability ?? "")) {
            respond(401, capabilityDenied("unauthorized"), true);
            return;
          }
          if (!isValidControlRequestId(presentedRequestId ?? "")) {
            respond(400, controlErr("bad_request", "invalid request id"), true);
            return;
          }
          const admitted = handler.preflight(presentedCapability);
          if (!admitted.ok) {
            respond(
              admitted.denial === "unauthorized" ? 401 : 403,
              capabilityDenied(admitted.denial),
              true,
            );
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
        const controller = new AbortController();
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
        let releaseHandlerOnExit = true;

        try {
          const operation = (async (): Promise<{
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
            return dispatchControlRequest(
              handlers,
              token,
              {
                method,
                path: rawTarget,
                token: presentedToken,
                ...(presentedCapability === undefined
                  ? {}
                  : { capability: presentedCapability }),
                ...(presentedRequestId === undefined
                  ? {}
                  : { requestId: presentedRequestId }),
                body: body.body,
              },
              controller.signal,
            );
          })().catch((error: unknown) => ({
            status: 500,
            envelope: controlErr("failed", "browser control operation failed"),
            closeConnection: false,
          }));

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
          if (outcome.aborted) {
            releaseHandlerOnExit = false;
            void operation.then(() => {
              activeHandlers -= 1;
            });
            if (deadlineExpired) {
              respond(
                504,
                controlErr("timeout", `browser control handler exceeded ${handlerTimeoutMs}ms`),
                true,
              );
            }
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
          if (releaseHandlerOnExit) activeHandlers -= 1;
        }
      })();
    },
  );
  server.headersTimeout = CONTROL_HEADERS_TIMEOUT_MS;
  server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
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
  unlinkSocket(socketPath);
  await listenOnSocket(server, socketPath);
  try {
    runtime.chmodSocket(socketPath, 0o600);
  } catch (error) {
    await closeServer(server);
    unlinkSocket(socketPath);
    throw error;
  }
  server.on("error", (error) => {
    console.error("[browser-control] server error:", error);
  });

  return {
    socketPath,
    close: () => {
      server.close();
      if (ownsCapabilities) capabilities.close();
      try {
        unlinkSocket(socketPath);
      } catch {
        // socket file may already be gone
      }
    },
  };
};
