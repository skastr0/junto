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
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { artifacts, region, seat as seatNode, taskBoard, wire } from "./support/model-nodes";
import { ModelService } from "../src/main/junto/model/service";
import { asCanvasName, asWireId } from "../src/shared/model";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import {
  SeatGuidanceRepository,
  SeatGuidanceRepositoryLive,
} from "../src/main/junto/seat-guidance/repository";
import { ONBOARD_GUIDANCE, SEAT_GUIDANCE_LINE } from "../src/shared/seat-onboarding";
import { ARTIFACTS_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import { AgentSignalRepository } from "../src/main/junto/signals/repository";
import { SINCE_UNAVAILABLE } from "../src/main/junto/work/seat-since-read";

const CANVAS = "onboard";
const PEERS = ["peer-a", "peer-b", "peer-c"] as const;

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      SeatGuidanceRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  const workLive = Layer.provideMerge(WorkLive, canvasesLive);
  return ManagedRuntime.make(Layer.mergeAll(workLive, PausePlaneAllPlaying));
};

const seat = (id: string, x: number) =>
  seatNode(id, {
    x,
    y: 40,
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

/** One seat in a briefed region, wired by messages wires to the given peers. */
const nodes = () => [
  region("region", { x: -40, y: -40, width: 900, height: 300 }, {
    label: "PTY",
    instruction: "We are working on the PTY subsystem.",
  }),
  seat("agent", 0),
  ...PEERS.map((id, index) => seat(id, 160 * (index + 1))),
];

/**
 * The same seat with resources around it. Its reach: the task board beside
 * it and the loose artifacts node, never the board in the region next door.
 */
const withResources = () => [
  ...nodes(),
  taskBoard("board-in", { x: 0, y: 150, width: 200, height: 60 }),
  region("next-door", { x: 1000, y: -40, width: 400, height: 300 }, { label: "Canvas" }),
  taskBoard("board-away", { x: 1040, y: 40, width: 200, height: 60 }),
  artifacts("shelf", { x: 2000, y: 40, width: 200, height: 60 }),
];

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let seatCredential = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-onboard-output-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  seatCredential = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const write = async (peers: ReadonlyArray<string>, layout: () => Parameters<typeof seedCanvas>[1] = nodes) => {
  const model = await runtime.runPromise(ModelService);
  if (!(await runtime.runPromise(model.listCanvases())).some((name) => name === CANVAS)) {
    await runtime.runPromise(
      seedCanvas(CANVAS, layout(), peers.map((id) => wire(`edge-${id}`, "agent", id, "messages"))),
    );
    return;
  }
  // Written again, the seat keeps only the connections named this time.
  const cut = PEERS.filter((id) => !peers.includes(id)).map((id) => asWireId(`edge-${id}`));
  await runtime.runPromise(
    model.command({ _tag: "Remove", canvas: asCanvasName(CANVAS), nodes: [], wires: cut }, "operator"),
  );
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
  it("still onboards, with since marked unavailable, when the since read dies", async () => {
    await write(PEERS);
    // A signals service missing the method the read calls: a defect, not a failure.
    const broken = { listSeat: () => Effect.die(new TypeError("listSeat broke")) } as unknown as AgentSignalRepository["Service"];
    await server.close();
    server = await startWorkControlServer({
      version: "test",
      workHome: process.env.JUNTO_WORK_HOME!,
      home: root,
      run: (effect) => runtime.runPromise(effect.pipe(Effect.provideService(AgentSignalRepository, broken))),
      authoringGate: createMainAuthoringGate(),
    });
    seatCredential = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
    const error = console.error;
    console.error = () => undefined;
    try {
      const data = await onboard();
      expect(data.since).toEqual(SINCE_UNAVAILABLE);
      expect(data.guidance).toEqual([...ONBOARD_GUIDANCE]);
    } finally {
      console.error = error;
    }
  });

  it("reads most stable first: the operator's words, then who and what, then since the last session", async () => {
    await write(PEERS);
    const data = await onboard();
    expect(Object.keys(data)).toEqual([
      "guidance",
      "region",
      "seat",
      "nodeRef",
      "node",
      "role",
      "overseer",
      "protocol_version",
      "paused",
      "connected",
      "commands",
      "reach",
      ...("rulings" in data ? ["rulings"] : []),
      "co_members",
      "tools",
      "since",
    ]);
    expect(data.guidance).toEqual([...ONBOARD_GUIDANCE]);
    expect(data.region).toMatchObject({ label: "PTY", instruction: "We are working on the PTY subsystem." });
    expect(data.seat).toMatchObject({ harness: "claude" });
    // The guidance already teaches feedback, blocked and escalate.
    expect(data.tools.map((tool: { id: string }) => tool.id)).toEqual(["preamble", "signal"]);
  });

  it("lists each connection with its grants and one shared command set for peers that hold the same ports", async () => {
    await write(PEERS);
    const data = await onboard();
    expect(data.connected.map((c: { id: string }) => c.id)).toEqual([...PEERS]);
    for (const connection of data.connected) {
      expect(Object.keys(connection)).toEqual(["id", "kind", "title", "name", "regions", "role", "grants"]);
      expect(connection.grants).toEqual(
        expect.arrayContaining(["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"]),
      );
    }
    expect(data.commands).toHaveLength(1);
    const [messages] = data.commands;
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
    expect(data.commands).toEqual([]);
    expect(data.guidance).toEqual([...ONBOARD_GUIDANCE]);
    // Seats by name under the region they share.
    expect(data.co_members).toEqual([{ region: "PTY", seats: [...PEERS] }]);
  });

  it("lists the resources in the seat's region reach by kind, and teaches each the commands reach admits", async () => {
    await write([], withResources);
    const data = await onboard();
    expect(data.reach.map(({ kind, count, targets }: { kind: string; count: number; targets: string[] }) => ({ kind, count, targets }))).toEqual([
      { kind: "task", count: 1, targets: ["board-in"] },
      { kind: "artifacts", count: 1, targets: ["shelf"] },
    ]);
    // No edge to either: reach admits them and teaches each its kind's whole
    // family, and the board next door is taught nothing.
    const taught = (kind: string) =>
      Object.values(data.reach.find((section: { kind: string }) => section.kind === kind).commands as Record<string, string>);
    expect(taught("task").some((command) => command.includes("junto task list --node board-in"))).toBe(TASKS_ENABLED);
    expect(taught("artifacts").some((command) => command.includes("junto artifact create"))).toBe(ARTIFACTS_ENABLED);
    expect(data.commands).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("board-away");
    // Resources are in reach, never co-members.
    expect(data.co_members).toEqual([{ region: "PTY", seats: [...PEERS] }]);
  });

  it("carries since your last session, and junto since gives the same projection, uncapped with all", async () => {
    await write(PEERS);
    const { since } = await onboard();
    expect(since).toEqual({ as_of: expect.any(String), unread: 0 });
    for (const args of [{}, { all: true }]) {
      const response = await call({ token: token(), op: "since", args });
      expect(response.ok).toBe(true);
      expect({ ...response.data, as_of: since.as_of }).toEqual(since);
    }
    const refused = await call({ token: token(), op: "since", args: { every: true } });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
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
