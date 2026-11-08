/**
 * Answering a signal types the answer into its seat. The mail is appended by
 * the core's signals handler and delivery is configured only in the core
 * (core-runtime.ts), so the handler must deliver; main's copy of
 * messageDelivery has no transport and its call returned "waiting", leaving
 * an answered seat sitting idle until a boot scan or a live event.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalsRpcs } from "../src/contract/core/signals";
import { MachineRepository } from "../src/core/machines/repository";
import { AgentSignalRepository } from "../src/core/signals/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { messageDelivery } from "../src/core/work/message-delivery";
import { WorkService } from "../src/core/work/service";
import type { AgentSignal } from "../src/shared/agent-signals";

const SIGNAL = vi.hoisted(
  (): AgentSignal => ({
    signalId: "s1",
    canvasName: "factory",
    nodeId: "seat-a",
    kind: "blocked",
    text: "ready?",
    createdAt: 1,
    state: "open",
  }),
);
const MESSAGE = "01M5EVKRB1X4P80GXRGDK8V5AS";

vi.mock("../src/core/signals/operator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/signals/operator")>();
  const answered = () => Effect.succeed({ ok: true as const, signal: SIGNAL, messageId: MESSAGE });
  return { ...actual, answerAgentSignal: answered, replyAgentSignal: answered, dismissAgentSignal: answered };
});

vi.mock("../src/core/vault/secret-put", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/vault/secret-put")>();
  return {
    ...actual,
    putSignalSecret: () => Effect.succeed({ ok: true as const, item: "TOKEN", signal: SIGNAL, messageId: MESSAGE }),
  };
});

const { SignalsHandlers } = await import("../src/core/ops/ipc-signals");

const scopes: Array<Scope.Closeable> = [];
const dirs: Array<string> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A work-service member this test never reaches: reaching it fails the test, loudly. */
const unsubscribed = (member: string) => (): (() => void) => {
  throw new Error(`${member}: the signals test never subscribes`);
};

/**
 * The signals group's client on its handlers; the stores are never reached, as
 * the answers are stubbed. A mock's left-out Effect members die when reached,
 * and the SQL client is the core's own, on a database of this test's.
 */
const signalsClient = async () => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const dir = await mkdtemp(join(tmpdir(), "junto-signal-answer-"));
  dirs.push(dir);
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      SignalsHandlers.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentSignalRepository, {}),
            Layer.mock(WorkService, {
              subscribeTopologyChanges: unsubscribed("WorkService.subscribeTopologyChanges"),
              subscribeWorkChanges: unsubscribed("WorkService.subscribeWorkChanges"),
              subscribeMailChanges: unsubscribed("WorkService.subscribeMailChanges"),
            }),
            Layer.mock(MachineRepository, {}),
            makeStateEngineLive(join(dir, "junto.db")),
          ),
        ),
      ),
      scope,
    ),
  );
  return Effect.runPromise(
    RpcTest.makeClient(SignalsRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
};

describe("an answered signal", () => {
  it("is typed into its seat by the core handler that answers it", async () => {
    const signals = await signalsClient();
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await Effect.runPromise(signals.SignalsAnswer({ signalId: "s1", text: "go ahead", silent: false, attachments: [] }));
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });

  it("types a reply handed back by the seat into it as well", async () => {
    const signals = await signalsClient();
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await Effect.runPromise(
      signals.SignalsReply({ signalId: "s1", reply: { kind: "artifact", markdown: "# Done", replyId: MESSAGE } }),
    );
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });

  it("types a secret answer's mail into its seat too", async () => {
    const signals = await signalsClient();
    const deliver = vi.spyOn(messageDelivery, "deliver").mockResolvedValue("delivered");
    await Effect.runPromise(signals.SignalsSecretPut({ request: { signalId: "s1", value: "x" } }));
    expect(deliver).toHaveBeenCalledWith("factory", "seat-a", MESSAGE);
  });
});
