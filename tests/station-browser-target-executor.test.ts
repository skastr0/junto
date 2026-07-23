import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserSessionInfo } from "../src/shared/ipc";
import type {
  StationBrowserRequest,
  StationBrowserSession,
} from "../src/shared/station-browser";
import type {
  BrowserResult,
  BrowserSessionAuthorizationSnapshot,
} from "../src/main/vellum/browser/sessions";
import {
  currentStationBrowserGeneration,
  makeStationBrowserArtifactStore,
  makeStationBrowserLocalClient,
  makeStationBrowserTargetExecutor,
  stationBrowserDelegatedOwner,
  STATION_BROWSER_SCREENSHOT_DIRECTORY,
} from "../src/main/vellum/browser/station-target-executor";
import { controlDir } from "../src/shared/browser-control";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const pageRef = "vellum://canvas/work?node=page-1";
const baseRequest = (
  action: StationBrowserRequest["action"],
): StationBrowserRequest => ({
  version: 1,
  requestId: `request-${action}`,
  originStationId: "command-a",
  targetStationId: "remote-a",
  authority: "agent-edge",
  agentRef: "vellum://canvas/work?node=agent-1",
  action,
  pageRef:
    action === "doctor" || action === "discover" || action === "list"
      ? undefined
      : pageRef,
  session:
    action === "open" ||
    action === "doctor" ||
    action === "discover" ||
    action === "list"
      ? undefined
      : {
          hostId: "remote-a",
          sessionId: "session-1",
          generation: "session-1",
        },
  issuedAt: 1,
  expiresAt: 2,
  nonce: `nonce-${action}`,
  payload:
    action === "goto"
      ? { url: "https://example.com/next" }
      : action === "eval"
        ? { code: "1+1" }
        : undefined,
});

const info = (
  sessionId = "session-1",
): BrowserSessionInfo => ({
  sessionId,
  ref: pageRef,
  nodeId: "page-1",
  hostId: "remote-a",
  url: "https://example.com/",
  profile: "synthetic",
  state: "ready",
  attached: false,
});

const snapshot = (
  owner: string,
  sessionId = "session-1",
): BrowserSessionAuthorizationSnapshot => ({
  owner,
  sessionId,
  generation: sessionId,
  ref: pageRef,
  hostId: "remote-a",
  profile: "synthetic",
  origin: "https://example.com",
  navigationInFlight: false,
});

const ok = <A>(data: A): BrowserResult<A> => ({ ok: true, data });
const fail = <A>(): BrowserResult<A> => ({
  ok: false,
  code: "not_found",
  message: "not found",
});

const fakePlane = () => {
  const owners: string[] = [];
  let currentSessionId = "session-1";
  let stopped = false;
  const plane = {
    owners,
    openForOwner: async (owner: string) => {
      owners.push(owner);
      return ok(info(currentSessionId));
    },
    awaitNavigationTerminalForOwner: async (
      owner: string,
      sessionId: string,
    ) => {
      owners.push(owner);
      return ok(info(sessionId));
    },
    gotoForOwner: (
      owner: string,
      _sessionId: string,
    ) => {
      owners.push(owner);
      currentSessionId = "session-2";
      return ok(info(currentSessionId));
    },
    evalForOwner: async (owner: string) => {
      owners.push(owner);
      return ok({ result: 2 });
    },
    screenshotForOwner: async (owner: string) => {
      owners.push(owner);
      return ok({ png: Uint8Array.from([137, 80, 78, 71]) });
    },
    stateForOwner: (owner: string, sessionId: string) => {
      owners.push(owner);
      return ok(info(sessionId));
    },
    listForOwner: (owner: string) => {
      owners.push(owner);
      return ok([info(currentSessionId)]);
    },
    closeForOwner: (owner: string, sessionId: string) => {
      owners.push(owner);
      return ok(info(sessionId));
    },
    stopForOwner: async (owner: string) => {
      owners.push(owner);
      stopped = true;
      return ok({ stopped: true });
    },
    authorizationSnapshotForOwner: (
      owner: string,
      sessionId: string,
    ) => {
      owners.push(owner);
      return stopped || sessionId !== currentSessionId
        ? fail<BrowserSessionAuthorizationSnapshot>()
        : ok(snapshot(owner, currentSessionId));
    },
    stoppedAuthorizationSnapshotForOwner: (
      owner: string,
      sessionId: string,
    ) =>
      stopped && sessionId === currentSessionId
        ? ok(snapshot(owner, currentSessionId))
        : fail<BrowserSessionAuthorizationSnapshot>(),
  };
  return plane;
};

describe("Remote station-local browser executor", () => {
  it("keeps owners station/principal-scoped and strips page/session metadata", async () => {
    const plane = fakePlane();
    const executor = makeStationBrowserTargetExecutor({
      stationId: "remote-a",
      role: "remote",
      sessions: plane,
      resolvePageTarget: async () => ({
        ok: true,
        data: {
          ref: pageRef,
          nodeId: "page-1",
          hostId: "remote-a",
          url: "https://example.com/",
          profile: "synthetic",
        },
      }),
      discoverPages: async () => [
        { pageRef, hostId: "remote-a" },
        { pageRef: "vellum://canvas/work?node=other", hostId: "other" },
      ],
      artifacts: { writePng: async () => "shot-1.png" },
    });
    const request = baseRequest("open");
    const owner = stationBrowserDelegatedOwner(request);
    await expect(executor(request)).resolves.toEqual({
      session: {
        hostId: "remote-a",
        sessionId: "session-1",
        generation: "session-1",
      },
    });
    await expect(executor(baseRequest("discover"))).resolves.toEqual({
      pages: [{ pageRef, hostId: "remote-a" }],
    });
    expect(plane.owners.every((seen) => seen === owner)).toBe(true);
    expect(JSON.stringify(await executor(baseRequest("list"))))
      .not.toMatch(/profile|url|title|synthetic/);
  });

  it("rechecks generation around eval, screenshot, close, state, and stop", async () => {
    const plane = fakePlane();
    const executor = makeStationBrowserTargetExecutor({
      stationId: "remote-a",
      role: "remote",
      sessions: plane,
      resolvePageTarget: async () => ({
        ok: true,
        data: {
          ref: pageRef,
          nodeId: "page-1",
          hostId: "remote-a",
          url: "https://example.com/",
          profile: "synthetic",
        },
      }),
      discoverPages: async () => [],
      artifacts: { writePng: async () => "shot-1.png" },
    });
    await expect(executor(baseRequest("eval"))).resolves.toEqual({ result: 2 });
    await expect(executor(baseRequest("screenshot"))).resolves.toEqual({
      artifact: { hostId: "remote-a", artifactRef: "shot-1.png" },
    });
    await expect(executor(baseRequest("state"))).resolves.toMatchObject({
      session: { generation: "session-1" },
    });
    await expect(executor(baseRequest("close"))).resolves.toMatchObject({
      session: { generation: "session-1" },
    });
    await expect(executor(baseRequest("stop"))).resolves.toMatchObject({
      session: { generation: "session-1" },
    });
  });

  it("rolls navigation to the exact new generation and rejects mixed or stale handles", async () => {
    const plane = fakePlane();
    const executor = makeStationBrowserTargetExecutor({
      stationId: "remote-a",
      role: "remote",
      sessions: plane,
      resolvePageTarget: async () => ({
        ok: true,
        data: {
          ref: pageRef,
          nodeId: "page-1",
          hostId: "remote-a",
          url: "https://example.com/",
          profile: "synthetic",
        },
      }),
      discoverPages: async () => [],
      artifacts: { writePng: async () => "shot-1.png" },
    });
    await expect(executor(baseRequest("goto"))).resolves.toEqual({
      session: {
        hostId: "remote-a",
        sessionId: "session-2",
        generation: "session-2",
      },
    });
    await expect(executor(baseRequest("eval")))
      .rejects.toMatchObject({ code: "not_found" });
    const mixed = {
      ...baseRequest("state"),
      session: {
        hostId: "other",
        sessionId: "session-2",
        generation: "session-2",
      } satisfies StationBrowserSession,
    };
    await expect(executor(mixed)).rejects.toMatchObject({
      code: "stale_generation",
    });
  });

  it("exposes current generation only for the exact owner/ref/host tuple", () => {
    const plane = fakePlane();
    const request = baseRequest("state");
    expect(currentStationBrowserGeneration(plane, request)).toBe("session-1");
    expect(currentStationBrowserGeneration(plane, {
      ...request,
      pageRef: "vellum://canvas/work?node=other",
    })).toBeUndefined();
  });

  it("projects the real station role and adapts local denials without another transport", async () => {
    const plane = fakePlane();
    const executor = makeStationBrowserTargetExecutor({
      stationId: "remote-a",
      role: "command-center",
      sessions: plane,
      resolvePageTarget: async () => ({
        ok: true,
        data: {
          ref: pageRef,
          nodeId: "page-1",
          hostId: "remote-a",
          url: "https://example.com/",
          profile: "synthetic",
        },
      }),
      discoverPages: async () => [],
      artifacts: { writePng: async () => "shot-1.png" },
    });
    await expect(executor(baseRequest("doctor"))).resolves.toEqual({
      role: "command-center",
      browserReady: true,
    });

    const local = makeStationBrowserLocalClient("remote-a", executor);
    await expect(local.execute({
      ...baseRequest("state"),
      session: {
        hostId: "remote-a",
        sessionId: "session-1",
        generation: "stale",
      },
    })).resolves.toMatchObject({
      ok: false,
      hostId: "remote-a",
      error: "stale_generation",
    });
    await expect(local.execute({
      ...baseRequest("open"),
      targetStationId: "other",
    })).resolves.toMatchObject({
      ok: false,
      hostId: "remote-a",
      error: "forbidden",
    });
  });
});

describe("Remote host-local screenshot artifact store", () => {
  it("writes one owner-private PNG under the fixed local artifact directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "vellum-station-shot-"));
    roots.push(home);
    const store = makeStationBrowserArtifactStore(home);
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const artifactRef = await store.writePng(bytes);
    expect(artifactRef).toMatch(/^shot-[a-f0-9]{48}\.png$/);
    const path = join(
      controlDir(home),
      STATION_BROWSER_SCREENSHOT_DIRECTORY,
      artifactRef,
    );
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the browser control root is a symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "vellum-station-shot-home-"));
    const target = await mkdtemp(join(tmpdir(), "vellum-station-shot-target-"));
    roots.push(home, target);
    await symlink(target, join(home, ".vellum"));
    const store = makeStationBrowserArtifactStore(home);
    await expect(store.writePng(Uint8Array.from([137, 80, 78, 71])))
      .rejects.toMatchObject({ code: "failed" });
    await expect(readFile(join(target, "browser", "station-shots")))
      .rejects.toBeDefined();
  });
});
