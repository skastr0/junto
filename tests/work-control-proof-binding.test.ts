import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { canvasOf, seat } from "./support/model-nodes";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import {
  WorkService,
  type WorkServiceShape,
} from "../src/main/junto/work/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import {
  type ProcessPrincipal,
} from "../src/main/junto/process-identity";
import {
  startWorkControlServer,
  type WorkControlServer,
} from "../src/main/junto/work/control";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import { injectionSupervisor } from "../src/main/junto/term/injection-supervisor";

// Regression: managed seats bind their PTY process by agent key with no
// bindingId (term/local-host.ts processPrincipal). The onboarding proof has
// to resolve the binding from the caller's node: reading only
// principal.bindingId would leave every such seat not onboarded, and nudged,
// however often it ran `junto onboard`.

const SEAT_BINDING = "binding-proof-seat";

/** Exactly the production principal shape for a managed agent seat. */
const PRINCIPAL: ProcessPrincipal = Object.freeze({
  agentKey: "local:proof-agent",
  canvasName: "proof",
  nodeId: "agent",
});

const canvas = canvasOf(
  [seat("agent", {
    width: 180,
    height: 60,
    label: "proof agent",
    agentKey: PRINCIPAL.agentKey!,
    bindingId: SEAT_BINDING as never,
    launch: { kind: "harness", argv: ["claude"] },
  })],
  [],
  "proof",
);
const workService = {
  listTopologies: () => Effect.succeed([canvas]),
  readTopology: () => Effect.succeed({ canvas, actorRefs: [] }),
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
  const root = await mkdtemp(join(tmpdir(), "junto-work-proof-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(WorkService, workService),
      PausePlaneAllPlaying,
    ),
  );
  const server = await startWorkControlServer({
    version: "proof-test",
    home: root,
    workHome,
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

describe("work control onboarding proof", () => {
  it("an onboard call from an agent-key-bound seat onboards the seat's terminal binding", async () => {
    injectionSupervisor.clearForTest();
    expect(injectionSupervisor.isOnboarded(SEAT_BINDING)).toBe(false);
    const rig = await startRig();
    const token = publishSeatCredential(rig.server.credentials, PRINCIPAL);

    const response = (await call(rig.server.socketPath, { token, op: "onboard" })) as {
      readonly ok: boolean;
    };

    expect(response.ok).toBe(true);
    expect(injectionSupervisor.isOnboarded(SEAT_BINDING)).toBe(true);
  });

  it("no other work-plane call onboards the seat", async () => {
    injectionSupervisor.clearForTest();
    const rig = await startRig();
    const token = publishSeatCredential(rig.server.credentials, PRINCIPAL);

    for (const op of ["capabilities", "preamble"]) {
      const response = (await call(rig.server.socketPath, { token, op, args: { text: "checking in" } })) as {
        readonly ok: boolean;
      };
      expect(response.ok).toBe(true);
    }

    expect(injectionSupervisor.isOnboarded(SEAT_BINDING)).toBe(false);
  });
});
