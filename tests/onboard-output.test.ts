/**
 * `junto onboard` is the one loader, over the real work-control socket.
 * Nothing is sent to a harness at session start, so this output is everything
 * a seat is told: short guidance, the seat's facts, the operator's standing
 * instructions, and the commands each connection allows. It stays short.
 * Every store, home, and socket lives under a temp root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
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
  SeatGuidanceRepository,
  SeatGuidanceRepositoryLive,
} from "../src/main/junto/seat-guidance/repository";
import type { CanvasDoc } from "../src/shared/canvas";
import { ONBOARD_GUIDANCE, SEAT_GUIDANCE_LINE } from "../src/shared/seat-onboarding";

const CANVAS = "onboard";
const PEERS = ["peer-a", "peer-b", "peer-c"] as const;

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      SeatGuidanceRepositoryLive,
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

const seat = (id: string, x: number): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  x,
  y: 40,
  width: 120,
  height: 48,
  text: id,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: `bind-${id}`,
      harness: "claude",
      launch: { kind: "harness", argv: ["claude"] },
    },
  },
});

/** One seat in a briefed region, wired by messages edges to the given peers. */
const doc = (peers: ReadonlyArray<string>): CanvasDoc => ({
  nodes: [
    {
      id: "region",
      type: "group",
      x: -40,
      y: -40,
      width: 900,
      height: 300,
      label: "PTY",
      ether: { region: { instruction: "We are working on the PTY subsystem." } },
    },
    seat("agent", 0),
    ...PEERS.map((id, index) => seat(id, 160 * (index + 1))),
  ],
  edges: peers.map((id) => ({
    id: `edge-${id}`,
    fromNode: "agent",
    toNode: id,
    ether: { verb: "messages" },
  })),
} as CanvasDoc);

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let seatCredential = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-onboard-output-"));
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
  seatCredential = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_CANVASES_DIR;
  delete process.env.JUNTO_WORK_HOME;
});

const write = async (peers: ReadonlyArray<string>) => {
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write(CANVAS, doc(peers)));
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

const token = () => seatCredential;
const onboard = async () => {
  const response = await call({ token: token(), op: "onboard", args: {} });
  expect(response.ok).toBe(true);
  return response.data;
};

describe("junto onboard output", () => {
  it("leads with the guidance, then the seat's facts and its compiled instructions", async () => {
    await write(PEERS);
    const data = await onboard();
    expect(Object.keys(data)).toEqual([
      "guidance",
      "nodeRef",
      "node",
      "seat",
      "role",
      "tools",
      "overseer",
      "protocol_version",
      "region",
      "connected",
      "instructions",
      ...("rulings" in data ? ["rulings"] : []),
      "co_members",
      "paused",
    ]);
    expect(data.guidance).toEqual([...ONBOARD_GUIDANCE]);
    expect(data.region).toMatchObject({ label: "PTY", instruction: "We are working on the PTY subsystem." });
    expect(data.seat).toMatchObject({ harness: "claude" });
    expect(data.tools.map((tool: { id: string }) => tool.id)).toEqual([
      "preamble",
      "escalate",
      "blocked",
      "feedback",
      "signal",
    ]);
  });

  it("lists each connection with its grants and one shared command set for peers that hold the same ports", async () => {
    await write(PEERS);
    const data = await onboard();
    expect(data.connected.map((c: { id: string }) => c.id)).toEqual([...PEERS]);
    for (const connection of data.connected) {
      expect(Object.keys(connection)).toEqual(["id", "kind", "title", "role", "grants"]);
      expect(connection.grants).toEqual(
        expect.arrayContaining(["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"]),
      );
    }
    expect(data.instructions).toHaveLength(1);
    const [messages] = data.instructions;
    expect(messages).toMatchObject({
      family: "messages",
      targets: [...PEERS],
      more: "junto docs node agent",
    });
    expect(messages.commands).toEqual({
      "read target thread": `junto msg list '{"target":"<target>"}'`,
      "send mail": `junto msg send '{"target":"<target>","text":"..."}'`,
      reply: `junto msg reply '{"target":"<target>","text":"...","inReplyTo":"<msgId>"}'`,
      prompt: `junto msg send --prompt '{"target":"<target>","text":"..."}'`,
      wait: "junto seat wait <target> --until idle --timeout 30s",
      observe: "junto seat read <target> --lines 40",
    });
  });

  it("an isolated seat is taught no connection commands and still gets the guidance", async () => {
    await write([]);
    const data = await onboard();
    expect(data.connected).toEqual([]);
    expect(data.instructions).toEqual([]);
    expect(data.guidance).toEqual([...ONBOARD_GUIDANCE]);
    expect(data.co_members.map((member: { id: string }) => member.id)).toEqual(
      expect.arrayContaining([...PEERS]),
    );
  });

  it("carries the operator's soul and standing instructions, read live", async () => {
    await write(["peer-a"]);
    expect((await onboard()).seat).not.toHaveProperty("instructions");
    await runtime.runPromise(
      Effect.flatMap(SeatGuidanceRepository, (store) =>
        store.set("agent", { soul: "A careful reviewer.", instructions: "Run the tests first." }),
      ),
    );
    const data = await onboard();
    expect(data.seat).toMatchObject({
      soul: "A careful reviewer.",
      instructions: "Run the tests first.",
    });
    expect(data.guidance).toEqual([...ONBOARD_GUIDANCE, SEAT_GUIDANCE_LINE]);
  });

  it("stays short: well under the 7.7 KB it used to return for three connections", async () => {
    await write(PEERS);
    const three = JSON.stringify(await onboard()).length;
    expect(three).toBeLessThan(4500);
    // No fact is repeated: connections appear once, tools once.
    const data = await onboard();
    expect(data).not.toHaveProperty("capabilities");
    expect(JSON.stringify(data).split('"msg.prompt"').length - 1).toBe(PEERS.length);
    // Commands are shared, so a further edge costs one connection row, not a command set.
    await write(["peer-a"]);
    const one = JSON.stringify(await onboard()).length;
    expect((three - one) / 2).toBeLessThan(250);
  });

  it("carries no middle dot and no injection vocabulary", async () => {
    await write(PEERS);
    const raw = JSON.stringify(await onboard());
    expect(raw).not.toContain("·");
    expect(raw).not.toMatch(/inject|system prompt|at spawn/i);
  });
});
