/**
 * Seats addressed by name over the real work-control socket. msg send, msg
 * send --prompt and msg reply take a seat's name or its node id; a name two
 * reachable seats share, or one no reachable seat has, is refused with the
 * seats it could mean. Every send answers with its recipient, mail carries
 * the regions its sender was in, and onboard, capabilities and msg sent name
 * every peer and where it is. Every store, home and socket lives under a temp
 * root.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { mentionLink } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import type { Message } from "../src/shared/work-model";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
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

const CANVAS = "names";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
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

const seat = (id: string, label: string, x: number) =>
  seatNode(id, {
    label,
    x,
    y: 40,
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

const mail = (a: string, b: string) => [
  wire(`${a}-${b}`, a, b, "messages"),
  wire(`${b}-${a}`, b, a, "messages"),
];

// Junto holds everything; CLI holds the caller and cli-lead; PTY holds the
// second reviewer. solo shares Junto with the caller and no wire.
const JUNTO = { id: "junto", name: "Junto" };
const CLI = { id: "cli", name: "CLI" };
const PTY = { id: "pty", name: "PTY" };

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-seat-names-"));
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
  for (const id of ["agent", "lead", "rev-a", "rev-b", "solo-seat"]) {
    tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  }
  await runtime.runPromise(
    seedCanvas(
      CANVAS,
      [
        region("junto", { x: -100, y: -100, width: 2000, height: 600 }, { label: "Junto" }),
        region("cli", { x: -50, y: 0, width: 400, height: 200 }, { label: "CLI" }),
        region("pty", { x: 600, y: 0, width: 400, height: 200 }, { label: "PTY" }),
        seat("agent", "worker", 0),
        seat("lead", "cli-lead", 160),
        seat("rev-a", "reviewer", 400),
        seat("rev-b", "reviewer", 640),
        seat("solo-seat", "solo", 1200),
      ],
      [...mail("agent", "lead"), ...mail("agent", "rev-a"), ...mail("agent", "rev-b")],
    ),
  );
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (as: string, op: string, args: unknown = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: tokens[as]!, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const mailbox = (nodeId: string): Promise<ReadonlyArray<Message>> =>
  runtime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, nodeId)));

const LEAD = { nodeId: "lead", name: "cli-lead", regions: [JUNTO, CLI] };

describe("a mail target is a seat's name or its node id", () => {
  it("msg send by name, in any case, reaches the seat and answers with who it reached", async () => {
    const sent = await call("agent", "msg.send", { target: "  CLI-Lead ", text: "the sync bug" });
    expect(sent.ok).toBe(true);
    expect(sent.data.recipient).toEqual(LEAD);
    expect((await mailbox("lead")).map((message) => message.messageId)).toEqual([sent.data.messageId]);
  });

  it("a node id still works, and answers with the recipient too", async () => {
    const sent = await call("agent", "msg.send", { target: "lead", text: "by id" });
    expect(sent.ok).toBe(true);
    expect(sent.data.recipient).toEqual(LEAD);
  });

  it("msg send --prompt takes a name", async () => {
    const prompted = await call("agent", "msg.prompt", { target: "cli-lead", text: "steer" });
    expect(prompted.ok).toBe(true);
    expect(prompted.data.recipient).toEqual(LEAD);
    expect((await mailbox("lead")).map((message) => message.messageId)).toEqual([prompted.data.messageId]);
  });

  it("msg reply takes a name", async () => {
    const asked = await call("lead", "msg.send", { target: "worker", text: "status?" });
    expect(asked.ok).toBe(true);
    const replied = await call("agent", "msg.reply", { target: "cli-lead", text: "green", inReplyTo: asked.data.messageId });
    expect(replied.ok).toBe(true);
    expect(replied.data.recipient).toEqual(LEAD);
    expect((await mailbox("lead")).some((message) => message.messageId === replied.data.messageId)).toBe(true);
  });

  it("refuses a name two reachable seats share, listing each with its id and regions", async () => {
    const refused = await call("agent", "msg.send", { target: "reviewer", text: "which one?" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
    expect(refused.error.details.candidates).toEqual([
      { kind: "agent", nodeId: "rev-a", name: "reviewer" },
      { kind: "agent", nodeId: "rev-b", name: "reviewer" },
    ]);
    expect(refused.error.message).toContain("reviewer (Junto) [rev-a]");
    expect(refused.error.message).toContain("reviewer (Junto / PTY) [rev-b]");
    expect(await mailbox("rev-a")).toEqual([]);
    expect(await mailbox("rev-b")).toEqual([]);
  });

  it("refuses a name no reachable seat has, naming the seats it can reach", async () => {
    for (const target of ["nobody", "solo"]) {
      const refused = await call("agent", "msg.send", { target, text: "hello?" });
      expect(refused.ok).toBe(false);
      expect(refused.error.type).toBe("UnknownTarget");
      expect(refused.error.details.candidates.map((candidate: { nodeId: string }) => candidate.nodeId)).toEqual(["lead", "rev-a", "rev-b"]);
      expect(refused.error.message).toContain("cli-lead (Junto / CLI) [lead]");
    }
    expect(await mailbox("solo-seat")).toEqual([]);
  });

  it("an id of a seat it is not wired to keeps the admission refusal it always had", async () => {
    const refused = await call("agent", "msg.send", { target: "solo-seat", text: "hello?" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("ScopeError");
  });
});

describe("reading another seat takes its name as mail does", () => {
  it("msg list on a wired seat's name reads its thread, as its id does", async () => {
    await call("agent", "msg.send", { target: "cli-lead", text: "one" });
    const byId = await call("agent", "msg.list", { target: "lead", peek: true });
    const byName = await call("agent", "msg.list", { target: "cli-lead", peek: true });
    expect(byId.ok).toBe(true);
    expect(byName).toEqual(byId);
  });

  it("seat read and seat wait on a wired seat's name answer as its id does", async () => {
    const byId = await call("agent", "seat.read", { target: "lead", lines: 1 });
    const byName = await call("agent", "seat.read", { target: "cli-lead", lines: 1 });
    expect(byId.ok, JSON.stringify(byId)).toBe(true);
    expect(byName.ok, JSON.stringify(byName)).toBe(true);
    expect(byName.data.target).toBe("lead");
    expect(byName.data.peer).toMatchObject({ nodeId: "lead", name: "cli-lead" });
    expect(byName.data.peer).toEqual(byId.data.peer);
    const waited = await call("agent", "seat.wait", { target: "cli-lead", until: "idle", timeoutMs: 1 });
    expect(waited.error?.type).not.toBe("ScopeError");
  });

  it("a name it is not wired to is refused naming the seats it can reach, not sent to the operator", async () => {
    const refused = await call("agent", "msg.list", { target: "solo", peek: true });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("UnknownTarget");
    expect(refused.error.details.candidates.map((candidate: { nodeId: string }) => candidate.nodeId)).toContain("lead");
  });
});

describe("mail says who sent it and where", () => {
  it("is stamped with the sender's regions, and msg read and msg list carry them", async () => {
    const sent = await call("agent", "msg.send", { target: "cli-lead", text: "from where?" });
    const stored = (await mailbox("lead")).find((message) => message.messageId === sent.data.messageId)!;
    expect(stored.metadata).toMatchObject({ senderName: "worker", senderRegions: [JUNTO, CLI] });
    const read = await call("lead", "msg.read", { messageId: sent.data.messageId });
    expect(read.data.message.metadata).toMatchObject({ senderName: "worker", senderRegions: [JUNTO, CLI] });
    const listed = await call("lead", "msg.list", {});
    expect(listed.data.items[0].metadata).toMatchObject({ senderName: "worker", senderRegions: [JUNTO, CLI] });
  });

  it("msg sent names each recipient and where it is", async () => {
    await call("agent", "msg.send", { target: "cli-lead", text: "one" });
    const sent = await call("agent", "msg.sent", {});
    expect(sent.ok).toBe(true);
    expect(sent.data.items[0].to).toEqual(LEAD);
  });
});

describe("every surface that lists peers names them", () => {
  it("onboard and capabilities give each connection and co-member its name and regions", async () => {
    for (const op of ["onboard", "capabilities"]) {
      const result = await call("agent", op, {});
      expect(result.ok).toBe(true);
      expect(result.data.connected.map((peer: any) => ({ id: peer.id, name: peer.name, regions: peer.regions }))).toEqual([
        { id: "lead", name: "cli-lead", regions: [JUNTO, CLI] },
        { id: "rev-a", name: "reviewer", regions: [JUNTO] },
        { id: "rev-b", name: "reviewer", regions: [JUNTO, PTY] },
      ]);
      // solo shares Junto; the regions themselves are geography, never peers.
      // Onboard names co-members by region; capabilities keeps their records.
      expect(result.data.co_members).toEqual(
        op === "onboard"
          ? [{ region: JUNTO.name, seats: ["solo"] }]
          : [expect.objectContaining({ id: "solo-seat", name: "solo", regions: [JUNTO], shared_region: JUNTO })],
      );
    }
  });
});

describe("an @name in mail text is written as its mention link", () => {
  const textOf = (message: Message): string => message.parts.flatMap((part) => ("text" in part ? [part.text as string] : [])).join("");
  const leadLink = mentionLink({ kind: "seat", nodeId: asNodeId("lead") }, "@cli-lead", CANVAS);

  it("msg send links a wired seat, and leaves code and emails alone", async () => {
    const sent = await call("agent", "msg.send", { target: "cli-lead", text: "@CLI-Lead see `@solo`, ops@junto.dev" });
    expect(sent.ok).toBe(true);
    expect((await mailbox("lead")).map(textOf)).toEqual([`${leadLink} see \`@solo\`, ops@junto.dev`]);
  });

  it("msg reply links it too", async () => {
    const asked = await call("lead", "msg.send", { target: "worker", text: "status?" });
    const replied = await call("agent", "msg.reply", { target: "cli-lead", text: "green, thanks @cli-lead", inReplyTo: asked.data.messageId });
    expect(replied.ok).toBe(true);
    const reply = (await mailbox("lead")).find((message) => message.messageId === replied.data.messageId);
    expect(reply === undefined ? "" : textOf(reply)).toContain(`green, thanks ${leadLink}`);
  });

  it("sends a seat it is not wired to as plain text, and the receipt lists the token", async () => {
    const sent = await call("agent", "msg.send", { target: "cli-lead", text: "ask @solo" });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect(sent.data.unlinked).toEqual([{ token: "@solo", nearest: [] }]);
    const held = await mailbox("lead");
    expect(held.map((message) => message.parts.map((part) => (part.kind === "text" ? part.text : "")).join(""))).toEqual(["ask @solo"]);
  });

  it("refuses a name two wired seats share, with both candidates", async () => {
    const refused = await call("agent", "msg.send", { target: "cli-lead", text: "ask @reviewer" });
    expect(refused.ok).toBe(false);
    expect(refused.error.type).toBe("InputError");
    expect(refused.error.details.target).toBe("@reviewer");
    expect(refused.error.details.candidates.map((candidate: { nodeId: string }) => candidate.nodeId)).toEqual(["rev-a", "rev-b"]);
  });
});
