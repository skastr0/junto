import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseNodeRef } from "@shared/node-ref";
import {
  controlDir,
} from "@shared/browser-control";
import {
  BROWSER_MAX_LIST_ROWS,
  BROWSER_MAX_SCREENSHOT_BYTES,
} from "@shared/browser-limits";
import type { BrowserSessionInfo } from "@shared/ipc";
import type {
  StationBrowserRequest,
  StationBrowserResponse,
  StationBrowserSession,
} from "@shared/station-browser";
import type { StationRole } from "@shared/station";
import type { StationBrowserLocalClient } from "./station-router";
import type {
  BrowserResult,
  BrowserSessionAuthorizationSnapshot,
} from "./sessions";
import type {
  PageTargetResolver,
  ResolvedPageTarget,
} from "./page-target";

export const STATION_BROWSER_SCREENSHOT_DIRECTORY = "station-shots";
export const STATION_BROWSER_SCREENSHOT_DIRECTORY_MODE = 0o700;
export const STATION_BROWSER_SCREENSHOT_FILE_MODE = 0o600;

type SessionPlane = {
  readonly openForOwner: (
    owner: string,
    target: ResolvedPageTarget,
    signal?: AbortSignal,
    revalidateTarget?: PageTargetResolver,
  ) => Promise<BrowserResult<BrowserSessionInfo>>;
  readonly awaitNavigationTerminalForOwner: (
    owner: string,
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<BrowserResult<BrowserSessionInfo>>;
  readonly gotoForOwner: (
    owner: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ) => BrowserResult<BrowserSessionInfo>;
  readonly evalForOwner: (
    owner: string,
    sessionId: string,
    code: string,
    signal?: AbortSignal,
  ) => Promise<BrowserResult<{ readonly result: unknown }>>;
  readonly screenshotForOwner: (
    owner: string,
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<BrowserResult<{ readonly png: Uint8Array }>>;
  readonly stateForOwner: (
    owner: string,
    sessionId: string,
  ) => BrowserResult<BrowserSessionInfo>;
  readonly listForOwner: (
    owner: string,
  ) => BrowserResult<ReadonlyArray<BrowserSessionInfo>>;
  readonly closeForOwner: (
    owner: string,
    sessionId: string,
  ) => BrowserResult<BrowserSessionInfo>;
  readonly stopForOwner: (
    owner: string,
    sessionId: string,
  ) => Promise<BrowserResult<unknown>>;
  readonly authorizationSnapshotForOwner: (
    owner: string,
    sessionId: string,
  ) => BrowserResult<BrowserSessionAuthorizationSnapshot>;
  readonly stoppedAuthorizationSnapshotForOwner: (
    owner: string,
    sessionId: string,
  ) => BrowserResult<BrowserSessionAuthorizationSnapshot>;
};

export interface StationBrowserArtifactStore {
  /** Writes only into a host-owned fixed directory and returns an opaque local ref. */
  readonly writePng: (
    png: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export interface StationBrowserTargetExecutorDeps {
  readonly stationId: string;
  readonly role: StationRole;
  readonly sessions: SessionPlane;
  readonly resolvePageTarget: PageTargetResolver;
  /**
   * Must apply current edge/operator scope before returning rows. The executor
   * strips profile, URL, title, and browser-state metadata from the wire.
   */
  readonly discoverPages: (
    request: StationBrowserRequest,
  ) => Promise<ReadonlyArray<Readonly<{ pageRef: string; hostId: string }>>>;
  readonly artifacts: StationBrowserArtifactStore;
}

export class StationBrowserTargetExecutionError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "forbidden"
      | "not_found"
      | "stale_generation"
      | "failed",
  ) {
    super("station browser target execution failed");
    this.name = "StationBrowserTargetExecutionError";
  }
}

const canonicalStationId = (value: string): boolean =>
  /^[A-Za-z0-9._:-]{1,128}$/.test(value);

export const stationBrowserDelegatedOwner = (
  request: Pick<
    StationBrowserRequest,
    "originStationId" | "authority" | "agentRef"
  >,
): string => {
  const principal =
    request.authority === "operator-ui"
      ? "operator"
      : request.agentRef ?? "missing";
  const digest = createHash("sha256")
    .update("vellum/station-browser-owner/v1", "utf8")
    .update("\0", "utf8")
    .update(request.originStationId, "utf8")
    .update("\0", "utf8")
    .update(request.authority, "utf8")
    .update("\0", "utf8")
    .update(principal, "utf8")
    .digest("hex");
  return `station-browser:${request.originStationId}:${digest.slice(0, 32)}`;
};

const sessionProjection = (
  snapshot: Pick<
    BrowserSessionAuthorizationSnapshot,
    "hostId" | "sessionId" | "generation"
  >,
): StationBrowserSession => ({
  hostId: snapshot.hostId,
  sessionId: snapshot.sessionId,
  generation: snapshot.generation,
});

const requireOk = <A>(
  result: BrowserResult<A>,
): A => {
  if (!result.ok) {
    throw new StationBrowserTargetExecutionError(
      result.code === "cancelled"
        ? "cancelled"
        : result.code === "not_found"
          ? "not_found"
          : result.code === "forbidden" ||
              result.code === "invalid" ||
              result.code === "unsupported_capability"
            ? "forbidden"
            : "failed",
    );
  }
  return result.data;
};

const matchingSnapshot = (
  sessions: SessionPlane,
  request: StationBrowserRequest,
  allowStopped = false,
): BrowserSessionAuthorizationSnapshot => {
  if (request.session === undefined || request.pageRef === undefined) {
    throw new StationBrowserTargetExecutionError("forbidden");
  }
  const owner = stationBrowserDelegatedOwner(request);
  let result = sessions.authorizationSnapshotForOwner(
    owner,
    request.session.sessionId,
  );
  if (!result.ok && allowStopped) {
    result = sessions.stoppedAuthorizationSnapshotForOwner(
      owner,
      request.session.sessionId,
    );
  }
  const snapshot = requireOk(result);
  if (
    snapshot.ref !== request.pageRef ||
    snapshot.hostId !== request.targetStationId ||
    snapshot.hostId !== request.session.hostId ||
    snapshot.generation !== request.session.generation ||
    snapshot.sessionId !== request.session.sessionId ||
    snapshot.navigationInFlight
  ) {
    throw new StationBrowserTargetExecutionError("stale_generation");
  }
  return snapshot;
};

export const currentStationBrowserGeneration = (
  sessions: SessionPlane,
  request: StationBrowserRequest,
): string | undefined => {
  try {
    return matchingSnapshot(
      sessions,
      request,
      request.action === "stop",
    ).generation;
  } catch {
    return undefined;
  }
};

const projectCurrentSession = (
  sessions: SessionPlane,
  request: StationBrowserRequest,
  sessionId: string,
): StationBrowserSession => {
  const snapshot = requireOk(
    sessions.authorizationSnapshotForOwner(
      stationBrowserDelegatedOwner(request),
      sessionId,
    ),
  );
  if (
    snapshot.ref !== request.pageRef ||
    snapshot.hostId !== request.targetStationId ||
    snapshot.navigationInFlight
  ) {
    throw new StationBrowserTargetExecutionError("stale_generation");
  }
  return sessionProjection(snapshot);
};

const projectOwnedSession = (
  sessions: SessionPlane,
  owner: string,
  stationId: string,
  sessionId: string,
): StationBrowserSession => {
  const snapshot = requireOk(
    sessions.authorizationSnapshotForOwner(owner, sessionId),
  );
  if (
    snapshot.hostId !== stationId ||
    snapshot.navigationInFlight
  ) {
    throw new StationBrowserTargetExecutionError("stale_generation");
  }
  return sessionProjection(snapshot);
};

export const makeStationBrowserTargetExecutor = (
  deps: StationBrowserTargetExecutorDeps,
) => {
  if (!canonicalStationId(deps.stationId)) {
    throw new StationBrowserTargetExecutionError("forbidden");
  }

  return async (
    request: StationBrowserRequest,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (
      signal?.aborted ||
      request.targetStationId !== deps.stationId
    ) {
      throw new StationBrowserTargetExecutionError(
        signal?.aborted ? "cancelled" : "forbidden",
      );
    }
    const owner = stationBrowserDelegatedOwner(request);

    switch (request.action) {
      case "doctor":
        return { role: deps.role, browserReady: true };
      case "discover": {
        const pages = await deps.discoverPages(request);
        const unique = new Map<string, { pageRef: string; hostId: string }>();
        for (const page of pages) {
          if (
            unique.size >= BROWSER_MAX_LIST_ROWS ||
            page.hostId !== deps.stationId ||
            !parseNodeRef(page.pageRef).ok
          ) {
            continue;
          }
          unique.set(page.pageRef, {
            pageRef: page.pageRef,
            hostId: page.hostId,
          });
        }
        return { pages: [...unique.values()] };
      }
      case "list": {
        const sessions = requireOk(deps.sessions.listForOwner(owner))
          .slice(0, BROWSER_MAX_LIST_ROWS)
          .map((session) =>
            projectOwnedSession(
              deps.sessions,
              owner,
              deps.stationId,
              session.sessionId,
            ));
        return { sessions };
      }
      case "open": {
        if (request.pageRef === undefined) {
          throw new StationBrowserTargetExecutionError("forbidden");
        }
        const target = requireOk(await deps.resolvePageTarget(request.pageRef));
        if (
          target.ref !== request.pageRef ||
          target.hostId !== deps.stationId
        ) {
          throw new StationBrowserTargetExecutionError("forbidden");
        }
        const opened = requireOk(await deps.sessions.openForOwner(
          owner,
          target,
          signal,
          () => deps.resolvePageTarget(request.pageRef!),
        ));
        const terminal = requireOk(
          await deps.sessions.awaitNavigationTerminalForOwner(
            owner,
            opened.sessionId,
            signal,
          ),
        );
        return {
          session: projectCurrentSession(
            deps.sessions,
            request,
            terminal.sessionId,
          ),
        };
      }
      case "goto": {
        matchingSnapshot(deps.sessions, request);
        const url = request.payload?.url;
        if (url === undefined) {
          throw new StationBrowserTargetExecutionError("forbidden");
        }
        const navigated = requireOk(
          deps.sessions.gotoForOwner(
            owner,
            request.session!.sessionId,
            url,
            signal,
          ),
        );
        const terminal = requireOk(
          await deps.sessions.awaitNavigationTerminalForOwner(
            owner,
            navigated.sessionId,
            signal,
          ),
        );
        return {
          session: projectCurrentSession(
            deps.sessions,
            request,
            terminal.sessionId,
          ),
        };
      }
      case "eval": {
        matchingSnapshot(deps.sessions, request);
        const code = request.payload?.code;
        if (code === undefined) {
          throw new StationBrowserTargetExecutionError("forbidden");
        }
        const evaluated = requireOk(
          await deps.sessions.evalForOwner(
            owner,
            request.session!.sessionId,
            code,
            signal,
          ),
        );
        matchingSnapshot(deps.sessions, request);
        return { result: evaluated.result };
      }
      case "screenshot": {
        matchingSnapshot(deps.sessions, request);
        const shot = requireOk(
          await deps.sessions.screenshotForOwner(
            owner,
            request.session!.sessionId,
            signal,
          ),
        );
        matchingSnapshot(deps.sessions, request);
        const artifactRef = await deps.artifacts.writePng(shot.png, signal);
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(artifactRef)) {
          throw new StationBrowserTargetExecutionError("failed");
        }
        matchingSnapshot(deps.sessions, request);
        return {
          artifact: {
            hostId: deps.stationId,
            artifactRef,
          },
        };
      }
      case "state": {
        const snapshot = matchingSnapshot(deps.sessions, request);
        requireOk(
          deps.sessions.stateForOwner(owner, snapshot.sessionId),
        );
        return { session: sessionProjection(snapshot) };
      }
      case "close": {
        const snapshot = matchingSnapshot(deps.sessions, request);
        requireOk(deps.sessions.closeForOwner(owner, snapshot.sessionId));
        const current = matchingSnapshot(deps.sessions, request);
        return { session: sessionProjection(current) };
      }
      case "stop": {
        const snapshot = matchingSnapshot(deps.sessions, request, true);
        requireOk(
          await deps.sessions.stopForOwner(owner, snapshot.sessionId),
        );
        const stopped = requireOk(
          deps.sessions.stoppedAuthorizationSnapshotForOwner(
            owner,
            snapshot.sessionId,
          ),
        );
        if (
          stopped.ref !== snapshot.ref ||
          stopped.hostId !== snapshot.hostId ||
          stopped.generation !== snapshot.generation
        ) {
          throw new StationBrowserTargetExecutionError("stale_generation");
        }
        return { session: sessionProjection(stopped) };
      }
    }
  };
};

export type StationBrowserTargetExecutor = ReturnType<
  typeof makeStationBrowserTargetExecutor
>;

/**
 * Adapts the station-local executor to the router's existing local branch.
 * It neither opens a second control listener nor serializes local work through
 * SSH; the owner-local UDS request remains the sole ingress.
 */
export const makeStationBrowserLocalClient = (
  stationId: string,
  execute: StationBrowserTargetExecutor,
): StationBrowserLocalClient => {
  if (!canonicalStationId(stationId)) {
    throw new StationBrowserTargetExecutionError("forbidden");
  }
  return Object.freeze({
    execute: async (
      request: StationBrowserRequest,
      signal?: AbortSignal,
    ): Promise<StationBrowserResponse> => {
      try {
        const data = await execute(request, signal);
        return {
          version: 1,
          requestId: request.requestId,
          action: request.action,
          ok: true,
          hostId: stationId,
          data,
        };
      } catch (error) {
        if (
          error instanceof StationBrowserTargetExecutionError &&
          error.code === "cancelled"
        ) {
          throw error;
        }
        return {
          version: 1,
          requestId: request.requestId,
          action: request.action,
          ok: false,
          hostId: stationId,
          error:
            error instanceof StationBrowserTargetExecutionError &&
              error.code === "stale_generation"
              ? "stale_generation"
              : "forbidden",
        };
      }
    },
  });
};

const ensureArtifactDirectory = async (
  path: string,
): Promise<void> => {
  try {
    await mkdir(path, {
      mode: STATION_BROWSER_SCREENSHOT_DIRECTORY_MODE,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const before = await lstat(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== uid
  ) {
    throw new StationBrowserTargetExecutionError("failed");
  }
  const directory = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await directory.chmod(STATION_BROWSER_SCREENSHOT_DIRECTORY_MODE);
    const opened = await directory.stat();
    if (
      !opened.isDirectory() ||
      opened.uid !== uid ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== STATION_BROWSER_SCREENSHOT_DIRECTORY_MODE
    ) {
      throw new StationBrowserTargetExecutionError("failed");
    }
  } finally {
    await directory.close();
  }
};

const ensureArtifactRoot = async (
  home: string,
): Promise<string> => {
  if (
    !isAbsolute(home) ||
    home.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(home)
  ) {
    throw new StationBrowserTargetExecutionError("failed");
  }
  const uid = process.getuid?.();
  const homeInfo = await lstat(home);
  if (
    uid === undefined ||
    homeInfo.isSymbolicLink() ||
    !homeInfo.isDirectory() ||
    homeInfo.uid !== uid
  ) {
    throw new StationBrowserTargetExecutionError("failed");
  }
  const vellum = join(home, ".vellum");
  await ensureArtifactDirectory(vellum);
  const browser = controlDir(home);
  await ensureArtifactDirectory(browser);
  const directory = join(
    browser,
    STATION_BROWSER_SCREENSHOT_DIRECTORY,
  );
  await ensureArtifactDirectory(directory);
  return directory;
};

/**
 * Host-local screenshot persistence. The artifact ref is a basename in the
 * fixed owner-private station-shots directory; no export or caller path exists.
 */
export const makeStationBrowserArtifactStore = (
  home = homedir(),
): StationBrowserArtifactStore => {
  return Object.freeze({
    writePng: async (
      png: Uint8Array,
      signal?: AbortSignal,
    ): Promise<string> => {
      if (
        signal?.aborted ||
        png.byteLength === 0 ||
        png.byteLength > BROWSER_MAX_SCREENSHOT_BYTES
      ) {
        throw new StationBrowserTargetExecutionError(
          signal?.aborted ? "cancelled" : "failed",
        );
      }
      const directory = await ensureArtifactRoot(home);
      const artifactRef = `shot-${randomBytes(24).toString("hex")}.png`;
      const path = join(directory, artifactRef);
      const file = await open(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        STATION_BROWSER_SCREENSHOT_FILE_MODE,
      );
      let complete = false;
      try {
        if (signal?.aborted) {
          throw new StationBrowserTargetExecutionError("cancelled");
        }
        await file.writeFile(png);
        await file.chmod(STATION_BROWSER_SCREENSHOT_FILE_MODE);
        await file.sync();
        const info = await file.stat();
        const uid = process.getuid?.();
        if (
          uid === undefined ||
          !info.isFile() ||
          info.uid !== uid ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== STATION_BROWSER_SCREENSHOT_FILE_MODE ||
          info.size !== png.byteLength
        ) {
          throw new StationBrowserTargetExecutionError("failed");
        }
        complete = true;
      } finally {
        await file.close();
        if (!complete) {
          // The exclusive descriptor minted this exact inode. A failed write
          // is retained rather than deleting through a bare caller path.
          // It is owner-private and cannot be mistaken for a returned artifact.
        }
      }
      return artifactRef;
    },
  });
};
