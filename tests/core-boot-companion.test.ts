import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Effect, Result } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, it } from "vitest";
import { startCore } from "../src/core/core";
import { companionService } from "../src/core/companion/service";
import { CompanionRpcs } from "../src/contract/core/companion";
import { CompanionHandlers } from "../src/core/ops/companion";
import { decodeOperatorResponse, encodeOperatorFrame, operatorControlSocketPath, type OperatorRequestEnvelope } from "../src/shared/operator-control";

const ask = (home: string, request: OperatorRequestEnvelope) =>
  new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(operatorControlSocketPath(home));
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encodeOperatorFrame(request)));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => {
      socket.destroy();
      const decoded = decodeOperatorResponse(JSON.parse(response));
      if (Result.isFailure(decoded)) reject(new Error(decoded.failure.message));
      else resolve(decoded.success);
    });
  });

// The core starts once per process, so the desktop core's phone companion is its own file.
it("answers a phone from the core: the companion is built there and the socket routes its ops to it", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  const devices: unknown[] = [];
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({
      home,
      build: "e".repeat(64),
      bundles: {},
      operator: { listen: "on-demand", commands: false },
      companion: {
        appVersion: "0.0.0-test",
        environment: async () => ({
          remoteLogin: "off",
          hostKey: undefined,
          tailscale: undefined,
          localName: "test",
          lanAddresses: [],
          hosts: [],
          user: "test",
          station: "test",
          juntoPath: undefined,
        }),
        onDevicesChanged: (next) => devices.push(next),
        showSignal: () => undefined,
      },
    });
    expect(await companionService()?.devices()).toEqual([]);
    // Settings reads the phones and this Mac's readiness from the core's companion, through the companion group.
    const [phones, status] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* RpcTest.makeClient(CompanionRpcs);
          return [yield* settings.CompanionDevices(), yield* settings.CompanionStatus()] as const;
        }),
      ).pipe(Effect.provide(CompanionHandlers)),
    );
    expect(phones).toEqual([]);
    expect(status).toMatchObject({ available: true, station: "test" });
    // No phone is paired, so boot left the socket closed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(operatorControlSocketPath(home))).toBe(false);
    await core.ensureOperatorListening();
    const answer = await ask(home, { protocol: "junto-operator/v1", id: "c", op: "companion.hello", args: { deviceId: "dev_01M65W89W7RMY723M451C6TKRJ" } });
    // The companion itself answered: an unknown phone is refused as data, not as a missing companion.
    expect(answer).toMatchObject({ id: "c", op: "companion.hello" });
    expect(JSON.stringify(answer)).not.toContain("the phone companion is not available");
    await core.close();
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
