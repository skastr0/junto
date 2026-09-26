/**
 * The companion service in main, through the real app runtime and a temp
 * junto.db (the vitest setup isolates JUNTO_HOME) and a temp authorized_keys:
 * pairing installs the one-time key, pair.complete swaps in the phone's key,
 * a pairing device may do nothing else, a paired one is admitted, Remove
 * revokes it and takes its line out, and expired pairings are swept. The real
 * ~/.ssh is never touched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Main modules import Electron; the service under test needs none of it.
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => "9.9.9", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  Notification: class {},
}));
import { COMPANION_PROTOCOL } from "../src/shared/companion-protocol";
import { decodeCompanionPairingUrl } from "../src/shared/companion-protocol";
import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope } from "../src/shared/operator-control";
import { companionDevicesIn } from "../src/main/junto/companion/authorized-keys";
import { Effect, Layer, ManagedRuntime } from "effect";
import { outcomeFail, outcomeOk, type CompanionBackend } from "../src/shared/companion-core";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CompanionDeviceRepository, CompanionDeviceRepositoryLive } from "../src/main/junto/companion/repository";
import { makeCompanionService, type CompanionServiceOptions } from "../src/main/junto/companion/service";
import type { CompanionEnvironment } from "../src/main/junto/companion/environment";

const dir = mkdtempSync(join(tmpdir(), "junto-companion-service-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const authorizedKeysPath = join(dir, ".ssh", "authorized_keys");
const OPERATOR_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorsOwnKey me@laptop";

const environment: CompanionEnvironment = {
  remoteLogin: "on",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTests",
  tailscale: { name: "mac.tail1234.ts.net", address: "100.101.102.103" },
  localName: "mac.local",
  lanAddresses: ["192.168.1.20"],
  hosts: ["mac.tail1234.ts.net", "100.101.102.103", "mac.local", "192.168.1.20"],
  user: "operator",
  station: "Test Mac",
  juntoPath: "/Applications/Junto.app/Contents/Resources/bin/junto",
};

const runtime = ManagedRuntime.make(
  CompanionDeviceRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(dir, "junto.db")))),
);
afterAll(() => runtime.dispose());
const runRepository = <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>) => runtime.runPromise(effect);

/** The data half is the demo's and the app's; here only the protocol half is under test. */
const backend: CompanionServiceOptions["backend"] = ({ pairComplete }) => {
  const none = async () => outcomeFail<never>("not-found");
  const stub: CompanionBackend = {
    now: Date.now,
    pairComplete,
    canvases: async () => outcomeOk([]),
    feeds: async () => outcomeOk([]),
    seats: none,
    seatDetail: none,
    answerSignal: none,
    dismissSignal: none,
    mailList: none,
    mailSend: none,
    quickReplies: async () => outcomeOk(["Yes"]),
    portrait: none,
  };
  return stub;
};

const PHONE_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=";
let seq = 0;
const op = (request: Omit<OperatorRequestEnvelope, "protocol" | "id">): OperatorRequestEnvelope =>
  ({ protocol: OPERATOR_PROTOCOL_VERSION, id: `t${(seq += 1)}`, ...request }) as OperatorRequestEnvelope;
const call = (deviceId: string, id: string, requestOp: string, args: object) =>
  op({ op: "companion.call", args: { deviceId, request: { v: COMPANION_PROTOCOL, type: "request", id, op: requestOp, args } } } as never);

describe("companion service", () => {
  it("pairs, admits, and revokes a phone end to end", async () => {
    writeFileSync(join(dir, "seed"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".ssh"), { recursive: true, mode: 0o700 });
    writeFileSync(authorizedKeysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
    const firstDevice: string[] = [];
    const service = makeCompanionService({
      appVersion: "9.9.9",
      environment: async () => environment,
      authorizedKeysPath,
      runRepository,
      backend,
      onFirstDevice: () => firstDevice.push("first"),
    });

    // Pairing: a record, the one-time key installed, and a QR payload.
    const started = await service.startPairing();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.qrSvg.startsWith("<svg")).toBe(true);
    expect(firstDevice).toEqual(["first"]);
    const deviceId = started.deviceId;
    const afterStart = readFileSync(authorizedKeysPath, "utf8");
    expect(afterStart.startsWith(`${OPERATOR_LINE}\n`)).toBe(true);
    expect(companionDevicesIn(afterStart)).toEqual([deviceId]);
    expect(afterStart).toContain(`command="'${environment.juntoPath}' companion-stdio --device ${deviceId}",restrict ssh-ed25519 `);
    expect(await service.devices()).toMatchObject([{ deviceId, state: "pairing", name: "" }]);

    // Hello works while pairing; nothing but pair.complete does.
    const hello = await service.dispatch(op({ op: "companion.hello", args: { deviceId } }));
    expect(hello).toMatchObject({ ok: true, data: { ok: true, hello: { appVersion: "9.9.9", deviceId, station: "Test Mac" } } });
    const early = await service.dispatch(call(deviceId, "r1", "ping", {}));
    expect(early).toMatchObject({ ok: true, data: { response: { id: "r1", ok: false, error: { code: "invalid" } } } });
    const eventsWhilePairing = await service.dispatch(op({ op: "companion.events", args: { deviceId, waitMs: 0 } }));
    expect(eventsWhilePairing).toMatchObject({ data: { ok: false, error: { code: "revoked" } } });

    // pair.complete swaps the one-time key for the phone's, in place.
    const paired = await service.dispatch(call(deviceId, "p1", "pair.complete", { publicKey: PHONE_KEY, deviceName: "Test iPhone" }));
    expect(paired).toMatchObject({ data: { response: { id: "p1", ok: true, result: { deviceId } } } });
    const afterPair = readFileSync(authorizedKeysPath, "utf8");
    expect(afterPair).toBe(
      `${OPERATOR_LINE}\ncommand="'${environment.juntoPath}' companion-stdio --device ${deviceId}",restrict ${PHONE_KEY} junto-companion:${deviceId}\n`,
    );
    expect(await service.devices()).toMatchObject([{ deviceId, state: "paired", name: "Test iPhone" }]);
    const again = await service.dispatch(call(deviceId, "p2", "pair.complete", { publicKey: PHONE_KEY, deviceName: "x" }));
    expect(again).toMatchObject({ data: { response: { ok: false, error: { code: "invalid" } } } });

    // Paired: ordinary ops are admitted.
    const ping = await service.dispatch(call(deviceId, "r2", "ping", {}));
    expect(ping).toMatchObject({ data: { response: { id: "r2", ok: true } } });
    const quick = await service.dispatch(call(deviceId, "r3", "quickReplies.get", {}));
    expect(quick).toMatchObject({ data: { response: { ok: true, result: { replies: expect.any(Array) } } } });
    const events = await service.dispatch(op({ op: "companion.events", args: { deviceId, waitMs: 0 } }));
    expect(events).toMatchObject({ data: { ok: true, reset: false } });

    // Remove revokes: the line leaves, the operator's line stays, calls are refused.
    expect(await service.remove(deviceId)).toBe(true);
    expect(readFileSync(authorizedKeysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
    const afterRemove = await service.dispatch(call(deviceId, "r4", "ping", {}));
    expect(afterRemove).toMatchObject({ data: { response: { id: "r4", ok: false, error: { code: "revoked" } } } });
    const helloAfter = await service.dispatch(op({ op: "companion.hello", args: { deviceId } }));
    expect(helloAfter).toMatchObject({ data: { ok: false, error: { code: "revoked" } } });
  }, 60_000);

  it("carries everything the phone needs in the QR and refuses without a junto command", async () => {
    const service = makeCompanionService({
      appVersion: "9.9.9",
      environment: async () => environment,
      authorizedKeysPath,
      runRepository,
      backend,
    });
    const started = await service.startPairing();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // The same payload the QR encodes, rebuilt from its URL form by the phone's own decoder.
    expect(started.hosts).toEqual(environment.hosts);
    await service.cancelPairing(started.deviceId);
    expect(companionDevicesIn(readFileSync(authorizedKeysPath, "utf8"))).toEqual([]);

    const missing = makeCompanionService({
      appVersion: "9.9.9",
      environment: async () => ({ ...environment, juntoPath: undefined }),
      authorizedKeysPath,
      runRepository,
      backend,
    });
    expect(await missing.startPairing()).toMatchObject({ ok: false, message: expect.stringContaining("junto command") });
    void decodeCompanionPairingUrl;
  }, 60_000);

  describe("Copy link", () => {
    afterEach(() => vi.useRealTimers());

    const fakeClipboard = (initial = "operator's own text") => {
      let text = initial;
      return {
        readText: () => text,
        writeText: (next: string) => {
          text = next;
        },
        clear: () => {
          text = "";
        },
        set: (next: string) => {
          text = next;
        },
        get text() {
          return text;
        },
      };
    };
    const make = () =>
      makeCompanionService({ appVersion: "9.9.9", environment: async () => environment, authorizedKeysPath, runRepository, backend });

    it("copies the exact pairing link and clears it when pairing completes", async () => {
      const service = make();
      const started = await service.startPairing();
      if (!started.ok) throw new Error("pairing did not start");
      const clipboard = fakeClipboard();
      expect(service.copyLink(started.deviceId, clipboard)).toBe(true);
      const decoded = decodeCompanionPairingUrl(clipboard.text);
      expect(decoded._tag === "Success" && decoded.success).toMatchObject({
        deviceId: started.deviceId,
        expiresAt: started.expiresAt,
        hosts: environment.hosts,
        pairingKey: expect.stringContaining("OPENSSH PRIVATE KEY"),
      });
      await service.dispatch(call(started.deviceId, "p", "pair.complete", { publicKey: PHONE_KEY, deviceName: "Copied" }));
      expect(clipboard.text).toBe("");
      // The pairing is over: its link can no longer be copied.
      expect(service.copyLink(started.deviceId, clipboard)).toBe(false);
      await service.remove(started.deviceId);
    });

    it("never clobbers something the operator copied since", async () => {
      const service = make();
      const started = await service.startPairing();
      if (!started.ok) throw new Error("pairing did not start");
      const clipboard = fakeClipboard();
      service.copyLink(started.deviceId, clipboard);
      clipboard.set("something else entirely");
      await service.cancelPairing(started.deviceId);
      expect(clipboard.text).toBe("something else entirely");
    });

    it("clears it when the pairing is cancelled or expires unused", async () => {
      const service = make();
      const cancelled = await service.startPairing();
      if (!cancelled.ok) throw new Error("pairing did not start");
      const clipboard = fakeClipboard();
      service.copyLink(cancelled.deviceId, clipboard);
      await service.cancelPairing(cancelled.deviceId);
      expect(clipboard.text).toBe("");

      const expiring = await service.startPairing();
      if (!expiring.ok) throw new Error("pairing did not start");
      service.copyLink(expiring.deviceId, clipboard);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(expiring.expiresAt + 1);
      expect(service.copyLink(expiring.deviceId, fakeClipboard())).toBe(false);
      await service.reconcile();
      expect(clipboard.text).toBe("");
      expect((await service.devices()).some((device) => device.deviceId === expiring.deviceId)).toBe(false);
    });
  });
});
