/**
 * `junto offboard` and onboard's past sessions over the real work-control
 * socket: the process-bound seat writes notes for its own current session
 * only, and the next onboard hands back past sessions, newest first, with the
 * latest notes inline, the paths to the rest, and the past-sessions framing.
 * Every store, home, and socket lives under a temp root.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame, workControlTokenPath } from "../src/shared/work-control";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { makeProcessIdentityMap } from "../src/main/junto/process-identity";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import {
  makeSeatSessionRepositoryLive,
  SeatSessionRepository,
} from "../src/main/junto/seat-sessions/repository";
import { subscribeSeatOffboard, type SeatOffboardEvent } from "../src/main/junto/seat-sessions/service";
import type { CanvasDoc } from "../src/shared/canvas";
import { PAST_SESSIONS_FRAMING } from "../src/shared/seat-sessions";

const CANVAS = "sessions";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive));
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seatDoc = (sessionId: string | undefined): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 120,
      height: 48,
      text: "agent",
      ether: {
        entity: { kind: "agent", name: "local:agent" },
        terminal: {
          bindingId: "bind-agent",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
          ...(sessionId ? { sessionId } : {}),
        },
      },
    },
    {
      id: "other",
      type: "text",
      x: 200,
      y: 0,
      width: 120,
      height: 48,
      text: "other",
      ether: {
        entity: { kind: "agent", name: "local:other" },
        terminal: {
          bindingId: "bind-other",
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
          sessionId: "other-session",
        },
      },
    },
  ],
  edges: [],
});

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-sessions-ctl-"));
  const workHome = join(root, "work");
  mkdirSync(join(root, "canvases"), { recursive: true });
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_CANVASES_DIR = join(root, "canvases");
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({ role: "command-center", hostId: "local", supervisedPreferred: true }),
  );
  await writeSession("s1");
  const processMap = makeProcessIdentityMap();
  processMap.bind(process.pid, { agentKey: "local:agent" });
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    processMap,
    readPeerPid: () => process.pid,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_CANVASES_DIR;
  delete process.env.JUNTO_WORK_HOME;
});

const writeSession = async (sessionId: string | undefined) => {
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write(CANVAS, seatDoc(sessionId)));
  // What the app's canvas recorder does on this commit.
  if (sessionId) {
    await runtime.runPromise(
      Effect.flatMap(SeatSessionRepository, (r) => r.record({ seatId: "agent", sessionId, harness: "claude" })),
    );
  }
};

const call = (body: unknown): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame(body)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const token = () => readFileSync(workControlTokenPath(process.env.JUNTO_WORK_HOME!), "utf8").trim();
const op = (name: string, args: unknown) => call({ token: token(), op: name, args });

describe("junto offboard", () => {
  it("writes notes for the caller's own current session and announces it", async () => {
    const events: SeatOffboardEvent[] = [];
    const unsubscribe = subscribeSeatOffboard((event) => events.push(event));
    try {
      const notes = "# Parser shipped\n\n- next: retry on 429\n- why: nightly sync fails without it";
      const result = await op("offboard", { notes });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ session_id: "s1", gist: "Parser shipped", disposition: "applied" });
      expect(result.data.notes_path).toBe(join(root, "seats", "agent", "sessions", "s1.md"));
      expect(await readFile(result.data.notes_path, "utf8")).toBe(`${notes}\n`);
      expect(events).toEqual([expect.objectContaining({ seatId: "agent", canvasName: CANVAS, sessionId: "s1" })]);

      // Only the caller's own seat: the other seat's history is untouched.
      const other = await runtime.runPromise(Effect.flatMap(SeatSessionRepository, (r) => r.list("other")));
      expect(other).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("refuses notes that say nothing, unknown fields, and a seat whose session id is not known", async () => {
    const empty = await op("offboard", { notes: "  \n " });
    expect(empty).toMatchObject({ ok: false, error: { type: "InputError" } });
    // Identity comes from the process, never from the payload.
    const claimed = await op("offboard", { notes: "x", seatId: "other" });
    expect(claimed).toMatchObject({ ok: false, error: { type: "InputError" } });

    await writeSession(undefined);
    const unknown = await op("offboard", { notes: "Notes" });
    expect(unknown).toMatchObject({ ok: false, error: { type: "InvalidTransition" } });
    expect(unknown.error.details.retryable).toBe(true);
  });
});

describe("junto onboard past sessions", () => {
  it("lists past sessions newest first, latest notes inline, framed as history", async () => {
    await op("offboard", { notes: "First session: set up the repo" });
    await writeSession("s2");
    await op("offboard", { notes: "Second session: wired the parser" });
    await writeSession("s3");
    await writeSession("s4");

    const onboard = await op("onboard", {});
    expect(onboard.ok).toBe(true);
    const sessions = onboard.data.sessions;
    expect(sessions.note).toBe(PAST_SESSIONS_FRAMING);
    expect(sessions.current).toMatchObject({ session_id: "s4", offboarded: false });
    expect(sessions.current.notes_path).toBe(join(root, "seats", "agent", "sessions", "s4.md"));
    expect(sessions.past.map((s: { session_id: string }) => s.session_id)).toEqual(["s3", "s2", "s1"]);
    const [s3, s2, s1] = sessions.past;
    // A session that never offboarded has no notes to point at.
    expect(s3).toMatchObject({ gist: null, notes_path: null, ended_because: "replaced" });
    expect(s3).not.toHaveProperty("notes");
    expect(s2).toMatchObject({
      gist: "Second session: wired the parser",
      notes_path: join(root, "seats", "agent", "sessions", "s2.md"),
      notes: "Second session: wired the parser",
    });
    expect(s1.notes).toBe("First session: set up the repo");

    // The inline count is configurable; older notes keep their paths.
    const one = await op("onboard", { past_notes: 1 });
    const [, t2, t1] = one.data.sessions.past;
    expect(t2.notes).toBe("Second session: wired the parser");
    expect(t1).not.toHaveProperty("notes");
    expect(t1.notes_path).toBe(join(root, "seats", "agent", "sessions", "s1.md"));

    const tooMany = await op("onboard", { past_notes: 99 });
    expect(tooMany).toMatchObject({ ok: false, error: { type: "InputError" } });
  });
});
