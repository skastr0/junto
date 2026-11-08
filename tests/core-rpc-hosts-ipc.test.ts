/**
 * The hosts group (src/contract/core/hosts-ipc.ts) answered by its handlers
 * (src/core/ops/hosts-ipc.ts), called through the group's own client: the
 * window's one machine command answers in the owner envelope, its progress
 * is published tagged with the call that asked for it, and a command that is
 * not a machine command is refused before the owner is asked. The wire is
 * proved for every group in tests/core-link-view-state.test.ts. The doctor's
 * services are present and unimplemented: this test asks no report, and any
 * member reached fails it.
 */
import { Effect, Layer } from "effect";
import { RpcTest, type RpcClient } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { MACHINE_PROGRESS } from "../src/contract/core/channels";
import { HostsRpcs } from "../src/contract/core/hosts-ipc";
import { HostsHandlers } from "../src/core/ops/hosts-ipc";
import { MachineOwnerControl } from "../src/core/hosts/machine-owner";
import { HostsService } from "../src/core/hosts/service";
import { KernelService } from "../src/core/kernel/service";
import { ModelService } from "../src/core/model/service";
import { CorePushes } from "../src/core/push";
import { CodexService } from "../src/core/services/codex";
import { SettingsService } from "../src/core/settings/service";
import { UsageService } from "../src/core/usage/usage-service";
import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope } from "../src/shared/operator-control";
import type { MachineSendEvent } from "../src/shared/machine-progress";

/** A doctor-service member this test never reaches: reaching it fails the test, loudly. */
const unreached = (member: string) => (): never => {
  throw new Error(`${member}: the hosts test asks no doctor report`);
};

const asked = (): { readonly requests: Array<OperatorRequestEnvelope>; readonly pushes: Array<readonly [string, unknown]> } => ({
  requests: [],
  pushes: [],
});

/** The group's handlers over an owner that records what it was asked and reports one install step. */
const hostsOver = (record: ReturnType<typeof asked>) => {
  const owner = Layer.succeed(MachineOwnerControl, {
    dispatch: (request: OperatorRequestEnvelope, observer?: (event: MachineSendEvent) => void) =>
      Effect.sync(() => {
        record.requests.push(request);
        observer?.({ event: "machine-install", juntoHome: "/home/probe", installRoot: "/home/probe/install", step: "selected" });
        return {
          protocol: OPERATOR_PROTOCOL_VERSION,
          id: request.id,
          op: request.op,
          ok: false as const,
          error: { type: "io" as const, message: "installed; setup refused", details: { retryable: false } },
        };
      }),
  });
  const pushes = Layer.succeed(CorePushes, {
    publish: (channel, payload) => Effect.sync(() => void record.pushes.push([channel, payload])),
  });
  // Every Effect member a mock leaves out dies when reached; the plain members are named here and throw.
  const doctorServices = Layer.mergeAll(
    Layer.mock(CodexService)({}),
    Layer.mock(ModelService)({
      subscribeChanges: unreached("ModelService.subscribeChanges"),
      subscribeCanvasesChanges: unreached("ModelService.subscribeCanvasesChanges"),
    }),
    Layer.mock(KernelService)({
      wakeManagedSeat: unreached("KernelService.wakeManagedSeat"),
      start: unreached("KernelService.start"),
      suspend: unreached("KernelService.suspend"),
      getSnapshot: unreached("KernelService.getSnapshot"),
      subscribe: unreached("KernelService.subscribe"),
    }),
    Layer.mock(UsageService)({ start: unreached("UsageService.start"), subscribe: unreached("UsageService.subscribe") }),
    Layer.mock(SettingsService)({ subscribe: unreached("SettingsService.subscribe") }),
    Layer.mock(HostsService)({}),
  );
  return HostsHandlers.pipe(Layer.provide(Layer.mergeAll(owner, pushes, doctorServices)));
};

const run = <A>(record: ReturnType<typeof asked>, use: (client: RpcClient.FromGroup<typeof HostsRpcs>) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(RpcTest.makeClient(HostsRpcs), use)).pipe(Effect.provide(hostsOver(record))));

describe("the hosts group", () => {
  it("answers a machine command in the owner envelope and publishes its progress for the asking call", async () => {
    const record = asked();
    const command = { protocol: OPERATOR_PROTOCOL_VERSION, id: "mini-send", op: "machine.send", args: { name: "mini" } };
    const response = await run(record, (hosts) => hosts.HostsCommand({ input: command, requestId: "call-1" }));
    expect(response).toMatchObject({ ok: false, id: "mini-send", op: "machine.send" });
    expect(record.requests).toHaveLength(1);
    // The owner's step is published whole, as it decoded, tagged with the command and the call that asked.
    expect(record.pushes).toEqual([
      [
        MACHINE_PROGRESS,
        {
          requestId: "call-1",
          progress: {
            id: "mini-send",
            event: { event: "machine-install", juntoHome: "/home/probe", installRoot: "/home/probe/install", step: "selected" },
          },
        },
      ],
    ]);
  });

  it("refuses a command that is not a machine command before the owner is asked", async () => {
    const record = asked();
    const hello = { protocol: OPERATOR_PROTOCOL_VERSION, id: "one", op: "companion.hello", args: { deviceId: "phone" } };
    const response = await run(record, (hosts) => hosts.HostsCommand({ input: hello, requestId: "call-2" }));
    expect(response).toMatchObject({ ok: false, error: { type: "validation" } });
    expect(record.requests).toEqual([]);
    expect(record.pushes).toEqual([]);
  });
});
