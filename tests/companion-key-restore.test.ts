/**
 * A paired phone whose authorized_keys line is gone.
 *
 * Junto cannot tell a lost line from one the operator or a security tool
 * removed, so it only marks the phone: the line stays gone across a reconcile
 * and a watched change until Restore is clicked. Restore rewrites exactly that
 * phone's line through the pairing writer and leaves every other byte alone;
 * a damaged stored key is never written; a pairing is never restored; a Junto
 * with its own home neither detects nor restores. Remove deletes the record
 * before the line, and key logs never carry a key or a line. Everything runs
 * on a temp junto.db and a temp authorized_keys.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => "9.9.9", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: {},
  Notification: class {},
}));
import type { CompanionBackend } from "../src/shared/companion-core";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { companionDevicesIn, companionKeyLine } from "../src/main/junto/companion/authorized-keys";
import { CompanionDeviceRepository, CompanionDeviceRepositoryLive } from "../src/main/junto/companion/repository";
import { makeCompanionService, type CompanionService } from "../src/main/junto/companion/service";
import type { CompanionEnvironment } from "../src/main/junto/companion/environment";

const A = "dev_01M594P2JVSWRGRSHY8GWTJN5B";
const B = "dev_01M594P2JVSWRGRSHY8GWTJN5C";
const C = "dev_01M594P2JVSWRGRSHY8GWTJN5D";
const PHONE_KEY_A = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAAAPhoneA=";
const PHONE_KEY_B = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAAAPhoneB=";
const PAIRING_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPairingKeyOnlyForTests";
const OPERATOR_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorsOwnKey me@laptop";
const JUNTO = "/Applications/Junto.app/Contents/Resources/bin/junto";

const environment: CompanionEnvironment = {
  remoteLogin: "on",
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForTests",
  tailscale: undefined,
  localName: "mac.local",
  lanAddresses: [],
  hosts: ["mac.local"],
  user: "operator",
  station: "Test Mac",
  juntoPath: JUNTO,
};

const lineOf = (deviceId: string, publicKey: string): string => companionKeyLine({ juntoPath: JUNTO, deviceId, publicKey });

let dir: string;
let keysPath: string;
let runtime: ManagedRuntime.ManagedRuntime<CompanionDeviceRepository, unknown>;
const services: CompanionService[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "junto-companion-restore-"));
  mkdirSync(join(dir, ".ssh"), { recursive: true, mode: 0o700 });
  keysPath = join(dir, ".ssh", "authorized_keys");
  runtime = ManagedRuntime.make(CompanionDeviceRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(dir, "junto.db")))));
});

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  vi.restoreAllMocks();
  await runtime.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>) => runtime.runPromise(effect);

const pair = (deviceId: string, publicKey: string) =>
  run(
    Effect.gen(function* () {
      const r = yield* CompanionDeviceRepository;
      yield* r.createPairing({ deviceId, pairingPublicKey: PAIRING_KEY, expiresAt: Date.now() + 600_000, now: Date.now() });
      yield* r.completePairing({ deviceId, publicKey, name: `Phone ${deviceId.slice(-1)}`, now: Date.now() });
    }),
  );

const make = (authorizedKeysPath: string | null = keysPath): CompanionService => {
  const service = makeCompanionService({
    appVersion: "9.9.9",
    environment: async () => environment,
    authorizedKeysPath,
    runRepository: run,
    backend: () => ({}) as CompanionBackend,
  });
  services.push(service);
  return service;
};

const keyOf = async (service: CompanionService, deviceId: string) =>
  (await service.devices()).find((device) => device.deviceId === deviceId);

const until = async (check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((done) => setTimeout(done, 50));
  }
};

describe("a phone whose line is gone", () => {
  it("stays gone across a reconcile and a watched change, until Restore is clicked", async () => {
    await pair(A, PHONE_KEY_A);
    writeFileSync(keysPath, `${OPERATOR_LINE}\n${lineOf(A, PHONE_KEY_A)}\n`, { mode: 0o600 });
    const service = make();
    await service.reconcile();
    expect((await keyOf(service, A))?.key).toBeUndefined();

    // The operator deletes the line by hand; the watcher sees it and only marks.
    // On macOS the watch goes live a moment after watch() returns, and a write in
    // that window is never reported (lost about 1 in 15 under load), so the same
    // deletion is written again until the watcher has marked it, a second apart:
    // each event restarts the watcher's settle wait, so a faster rewrite never settles.
    let wroteAt = 0;
    await until(async () => {
      if ((await keyOf(service, A))?.key === "missing") return true;
      if (Date.now() - wroteAt >= 1_000) {
        writeFileSync(keysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
        wroteAt = Date.now();
      }
      return false;
    });
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);

    // A reconcile (a restart) changes nothing either: no line, record and state kept.
    await service.reconcile();
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
    expect(await keyOf(service, A)).toMatchObject({ deviceId: A, state: "paired", key: "missing" });
    const restarted = make();
    await restarted.reconcile();
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
    expect((await keyOf(restarted, A))?.key).toBe("missing");

    // Only the click puts it back.
    expect(await service.restore(A)).toEqual({ ok: true, restored: [A], failed: [] });
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n${lineOf(A, PHONE_KEY_A)}\n`);
    expect((await keyOf(service, A))?.key).toBeUndefined();
  }, 20_000);

  it("Restore rewrites exactly that phone's line and leaves every other byte alone", async () => {
    await pair(A, PHONE_KEY_A);
    await pair(B, PHONE_KEY_B);
    // Odd bytes Junto must not touch: a comment, a blank line, tabs, CRLF, no final newline.
    const before = `# my keys\r\n${OPERATOR_LINE}\n\n\t${lineOf(B, PHONE_KEY_B)}\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther   other@box`;
    writeFileSync(keysPath, before, { mode: 0o600 });
    const service = make();
    await service.reconcile();
    expect((await keyOf(service, A))?.key).toBe("missing");
    expect((await keyOf(service, B))?.key).toBeUndefined();

    expect(await service.restore(A)).toEqual({ ok: true, restored: [A], failed: [] });
    expect(readFileSync(keysPath, "utf8")).toBe(`${before}\n${lineOf(A, PHONE_KEY_A)}\n`);
    // A second click finds the line there and writes nothing.
    expect(await service.restore(A)).toEqual({ ok: true, restored: [], failed: [] });
    expect(readFileSync(keysPath, "utf8")).toBe(`${before}\n${lineOf(A, PHONE_KEY_A)}\n`);
  }, 20_000);

  it("Restore all brings back every missing phone, and never a pairing or a damaged key", async () => {
    await pair(A, PHONE_KEY_A);
    await pair(B, PHONE_KEY_B);
    await pair(C, "not a key at all");
    writeFileSync(keysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
    const service = make();
    await service.reconcile();
    expect((await keyOf(service, C))?.key).toBe("damaged");

    const pending = await service.startPairing();
    if (!pending.ok) throw new Error(pending.message);
    // A pairing keeps its own one-time line and is never a restore target.
    expect(await service.restore(pending.deviceId)).toEqual({ ok: true, restored: [], failed: [] });

    const result = await service.restore("all");
    expect(result).toEqual({ ok: false, restored: [A, B], failed: [{ deviceId: C, reason: "damaged" }] });
    const text = readFileSync(keysPath, "utf8");
    expect(companionDevicesIn(text)).toEqual([pending.deviceId, A, B]);
    expect(text).not.toContain("not a key at all");
    expect((await keyOf(service, C))?.key).toBe("damaged");
    await service.cancelPairing(pending.deviceId);
  }, 20_000);

  it("an unusable junto path fails as junto-path, never as a damaged key", async () => {
    await pair(A, PHONE_KEY_A);
    writeFileSync(keysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
    const service = makeCompanionService({
      appVersion: "9.9.9",
      environment: async () => ({ ...environment, juntoPath: "/Applications/Jun'to/junto" }),
      authorizedKeysPath: keysPath,
      runRepository: run,
      backend: () => ({}) as CompanionBackend,
    });
    services.push(service);
    await service.reconcile();
    expect(await service.restore(A)).toEqual({ ok: false, restored: [], failed: [{ deviceId: A, reason: "junto-path" }] });
    expect((await keyOf(service, A))?.key).toBe("missing");
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
  }, 20_000);

  it("a Junto with its own home neither detects nor restores", async () => {
    await pair(A, PHONE_KEY_A);
    writeFileSync(keysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
    const preview = make(null);
    await preview.reconcile();
    expect((await keyOf(preview, A))?.key).toBeUndefined();
    expect(await preview.restore(A)).toMatchObject({ ok: false, restored: [], message: expect.stringContaining("own home") });
    expect(await preview.restore("all")).toMatchObject({ ok: false, restored: [] });
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
  }, 20_000);

  it("Remove deletes the record first, so a line that cannot be taken out leaves the phone refused", async () => {
    await pair(A, PHONE_KEY_A);
    const real = join(dir, "real_keys");
    writeFileSync(real, `${OPERATOR_LINE}\n${lineOf(A, PHONE_KEY_A)}\n`, { mode: 0o600 });
    symlinkSync(real, keysPath);
    const service = make();
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.map(String).join(" ")));
    await expect(service.remove(A)).rejects.toThrow(/was removed/u);
    expect(warned).toContain(`[companion] key remove-failed ${A} symlink`);
    expect(await keyOf(service, A)).toBeUndefined();
    expect(lstatSync(keysPath).isSymbolicLink()).toBe(true);
    const hello = await service.dispatch({ protocol: OPERATOR_PROTOCOL_VERSION, id: "h", op: "companion.hello", args: { deviceId: A } } as never);
    expect(hello).toMatchObject({ data: { ok: false, error: { code: "revoked" } } });
  }, 20_000);

  it("logs the device id, the outcome and a closed reason, never a key or a line", async () => {
    const lines: string[] = [];
    for (const level of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    await pair(A, PHONE_KEY_A);
    await pair(C, "not a key at all");
    writeFileSync(keysPath, `${OPERATOR_LINE}\n`, { mode: 0o600 });
    const service = make();
    await service.reconcile();
    await service.restore("all");
    await service.remove(A);
    const keyLines = lines.filter((line) => line.startsWith("[companion] key"));
    expect(keyLines).toEqual([
      `[companion] key missing ${A} missing`,
      `[companion] key missing ${C} damaged`,
      `[companion] key restored ${A}`,
      `[companion] key restore-failed ${C} damaged`,
      `[companion] key found ${A}`,
      `[companion] key removed ${A}`,
    ]);
    const all = lines.join("\n");
    for (const secret of [PHONE_KEY_A.split(" ")[1]!, "not a key at all", "command=", OPERATOR_LINE]) {
      expect(all).not.toContain(secret);
    }
  }, 20_000);
});
