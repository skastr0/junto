import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  encodeWorkFrame,
  workControlTokenPath,
} from "../src/shared/work-control";
import {
  CanvasError,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import {
  WorkService,
  type WorkServiceShape,
} from "../src/main/vellum-command/work/service";
import { PausePlaneAllPlaying } from "../src/main/vellum-command/pause-plane";
import {
  makeProcessIdentityMap,
  type ProcessPrincipal,
} from "../src/main/vellum-command/process-identity";
import {
  startWorkControlServer,
  type WorkControlServer,
} from "../src/main/vellum-command/work/control";
import { createMainAuthoringGate } from "../src/main/vellum-command/main-authoring-gate";
import { injectionSupervisor } from "../src/main/vellum-command/term/injection-supervisor";
import { canvasAuthorityMaterialFixture } from "./helpers/canvas-authority-material";

// Regression: managed seats bind their PTY process by agent key with no
// bindingId (term/local-host.ts processPrincipal). The supervisor's proof
// hook used to read only principal.bindingId, so proof never landed and the
// re-orientation floor nagged every proven seat forever.

const PEER_PID = 73_003;
const ANCHOR_PID = 73_002;
const SEAT_BINDING = "binding-proof-seat";

/** Exactly the production principal shape for a managed agent seat. */
const PRINCIPAL: ProcessPrincipal = Object.freeze({
  agentKey: "local:proof-agent",
  canvasName: "proof",
  nodeId: "agent",
});

const doc: CanvasDoc = {
  nodes: [
    {
      id: "agent",
      type: "text",
      x: 0,
      y: 0,
      width: 180,
      height: 60,
      text: "proof agent",
      ether: {
        entity: { kind: "agent", name: PRINCIPAL.agentKey },
        terminal: {
          bindingId: SEAT_BINDING,
          harness: "claude",
          launch: { kind: "harness", argv: ["claude"] },
        },
      },
    },
  ],
  edges: [],
};

const canvasesService = CanvasesService.of({
  doctor: Effect.succeed({ id: "canvases", label: "Canvases", status: "ok", detail: "proof test" }),
  list: Effect.succeed([]),
  read: (name) =>
    Effect.succeed({ name, revision: "a".repeat(64), doc, actorRefs: [], workRevision: "0" }),
  readWithIntentWitness: () => Effect.fail(new CanvasError({ message: "not used" })),
  readNodeStructure: () => Effect.fail(new CanvasError({ message: "not used" })),
  write: () => Effect.fail(new CanvasError({ message: "not used" })),
  mutate: () => Effect.fail(new CanvasError({ message: "not used" })),
  mutatePortfolio: () => Effect.fail(new CanvasError({ message: "not used" })),
  canvasOverseerSet: () => Effect.fail(new CanvasError({ message: "not used" })),
  create: () => Effect.fail(new CanvasError({ message: "not used" })),
  remove: () => Effect.fail(new CanvasError({ message: "not used" })),
  ensureSeed: Effect.void,
  writeSidecar: () => Effect.fail(new CanvasError({ message: "not used" })),
  start: () => undefined,
  subscribeChanges: () => () => undefined,
  announceInstalledProjection: () => {},
  liveDocuments: () => Effect.succeed([{ canvasName: "proof", doc }]),
  liveAuthorityGeneration: () => Effect.succeed("1"),
  authoritySnapshot: () =>
    Effect.succeed({
      generation: "1",
      intentSha256: "a".repeat(64),
      documents: new Map([["proof", doc]]),
    }),
  authorityMaterialSnapshot: () =>
    Effect.sync(() => canvasAuthorityMaterialFixture("1", new Map([["proof", doc]]))),
  activeIntentWitness: () =>
    Effect.succeed({ generation: "1", contentSha256: "a".repeat(64) }),
  activeActorRefs: () => Effect.succeed([]),
});

const workService = {
  commandStatus: Effect.succeed({
    counts: { pending: 0, applied: 0, rejected: 0 },
    pending: [],
    rejections: [],
    truncated: { pending: false, rejections: false },
  }),
} as unknown as WorkServiceShape;

const call = (socketPath: string, body: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("work control response timed out"));
    }, 5_000);
    socket.on("connect", () => socket.write(encodeWorkFrame(body)));
    socket.on("data", (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timer);
      const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      socket.destroy();
      resolve(frame);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

interface Rig {
  readonly root: string;
  readonly server: WorkControlServer;
  readonly runtime: { readonly dispose: () => Promise<void> };
}
const rigs: Rig[] = [];

const startRig = async (): Promise<Rig> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-command-work-proof-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  const map = makeProcessIdentityMap({
    processAlive: () => true,
    readProcessStartKey: (pid) => `generation:${pid}`,
    readParentPid: (pid) => (pid === PEER_PID ? ANCHOR_PID : undefined),
  });
  expect(map.bind(ANCHOR_PID, PRINCIPAL)).toBe(true);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(CanvasesService, canvasesService),
      Layer.succeed(WorkService, workService),
      PausePlaneAllPlaying,
    ),
  );
  const server = await startWorkControlServer({
    version: "proof-test",
    home: root,
    workHome,
    processMap: map,
    readPeerPid: () => PEER_PID,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  const rig: Rig = { root, server, runtime };
  rigs.push(rig);
  return rig;
};

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) continue;
    await rig.server.close();
    await rig.runtime.dispose();
    await rm(rig.root, { recursive: true, force: true });
  }
});

describe("work control bootstrap proof", () => {
  it("an onboard call from an agent-key-bound seat proves the seat's terminal binding", async () => {
    injectionSupervisor.clearForTest();
    expect(injectionSupervisor.isProven(SEAT_BINDING)).toBe(false);
    const rig = await startRig();
    const token = readFileSync(workControlTokenPath(join(rig.root, "work")), "utf8").trim();

    const response = (await call(rig.server.socketPath, { token, op: "onboard" })) as {
      readonly ok: boolean;
    };

    expect(response.ok).toBe(true);
    expect(injectionSupervisor.isProven(SEAT_BINDING)).toBe(true);
  });
});
