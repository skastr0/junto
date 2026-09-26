/**
 * Settings, Companion: pair a phone end to end against the running app,
 * without a phone and without sshd. The app shows the QR and installs the
 * one-time key; a stand-in phone runs the real `junto companion-stdio
 * --device` relay (what sshd's forced command runs) and completes pairing
 * with its own key; the phone appears, the key is swapped, and Remove takes
 * it back out. Frames land in test-results/companion/ (disposable).
 *
 *   bun run test:e2e:fast e2e/scenarios/companion-pairing.spec.ts
 *
 * The harness sandboxes HOME, so the authorized_keys written here is the
 * sandbox's. The operator's real ~/.ssh/authorized_keys is only read, before
 * and after, to prove it never changed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "companion");
const PHONE_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBE2eFakePhoneKeyForE2E=";
const OPERATOR_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorsOwnKeyE2E me@laptop";

const realKeysDigest = (): string => {
  const path = join(homedir(), ".ssh", "authorized_keys");
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
};

/** A phone stand-in: the real CLI relay, driven over stdio. */
const runPhone = (home: string, deviceId: string, lines: ReadonlyArray<string>) =>
  new Promise<ReadonlyArray<Record<string, any>>>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.JUNTO_HOME;
    const child = spawn("bun", [join(process.cwd(), "src/cli/main.ts"), "companion-stdio", "--device", deviceId], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const frames = out.trim().split("\n").filter(Boolean);
      // hello plus one response per request: the conversation is over.
      if (frames.length >= lines.length + 1) child.stdin.end();
    });
    child.on("error", reject);
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))));
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => child.kill(), 45_000);
  });

const request = (id: string, op: string, args: object = {}): string =>
  JSON.stringify({ v: "junto-companion/1", type: "request", id, op, args });

test("pairs a phone through the running app and removes it", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOTS, { recursive: true });
  const realBefore = realKeysDigest();
  const environment = {
    remoteLogin: "on",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKeyForE2E",
    tailscale: { name: "studio.tail1234.ts.net", address: "100.101.102.103" },
    localName: "studio.local",
    lanAddresses: ["192.168.1.20"],
    hosts: ["studio.tail1234.ts.net", "100.101.102.103", "studio.local", "192.168.1.20"],
    user: "operator",
    station: "Studio Mac",
    juntoPath: join(process.cwd(), "dist", "junto"),
  };
  const junto = await launchJunto({
    extraEnv: { JUNTO_E2E_COMPANION_ENVIRONMENT: JSON.stringify(environment) },
    afterSeed: async (sandbox) => {
      mkdirSync(join(sandbox.homeDir, ".ssh"), { recursive: true, mode: 0o700 });
      writeFileSync(join(sandbox.homeDir, ".ssh", "authorized_keys"), `${OPERATOR_LINE}\n`, { mode: 0o600 });
    },
  });
  try {
    const { page, sandbox } = junto;
    const keysPath = join(sandbox.homeDir, ".ssh", "authorized_keys");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    const openCompanion = async (mode: "dark" | "bright") => {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await page.locator(".settings-nav__item", { hasText: "Companion" }).click();
      await expect(page.getByText("Remote Login is on")).toBeVisible();
    };

    await openCompanion("dark");
    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "dark-ready.png") });

    // Pair: a QR, a pairing device, the one-time key in the sandbox's file.
    await page.getByRole("button", { name: "Pair a phone" }).click();
    await expect(page.getByTestId("companion-pairing").getByRole("img")).toBeVisible();
    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "dark-qr.png") });
    const devices = await page.evaluate(() => window.junto!.companionDevices!());
    const pending = devices.find((device) => device.state === "pairing");
    expect(pending).toBeDefined();
    const deviceId = pending!.deviceId;
    const withPairingKey = readFileSync(keysPath, "utf8");
    expect(withPairingKey.startsWith(`${OPERATOR_LINE}\n`)).toBe(true);
    expect(withPairingKey).toContain(`companion-stdio --device ${deviceId}",restrict ssh-ed25519 `);

    // The phone: the real relay, completing pairing with its own key.
    const frames = await runPhone(sandbox.homeDir, deviceId, [
      request("p1", "pair.complete", { publicKey: PHONE_KEY, deviceName: "E2E iPhone" }),
    ]);
    expect(frames[0]).toMatchObject({ type: "event", event: "hello", data: { deviceId, station: "Studio Mac" } });
    expect(frames.find((frame) => frame.id === "p1")).toMatchObject({ ok: true, result: { deviceId } });

    // The key is swapped in place; the operator's own line never moved.
    await expect(page.getByTestId("companion-phone")).toHaveCount(1);
    await expect(page.getByText("E2E iPhone is paired.")).toBeVisible();
    expect(readFileSync(keysPath, "utf8")).toBe(
      `${OPERATOR_LINE}\ncommand="'${environment.juntoPath}' companion-stdio --device ${deviceId}",restrict ${PHONE_KEY} junto-companion:${deviceId}\n`,
    );

    // Paired, the same relay answers ordinary requests from the running app.
    const session = await runPhone(sandbox.homeDir, deviceId, [request("r1", "ping"), request("r2", "canvases.list")]);
    expect(session.find((frame) => frame.id === "r1")).toMatchObject({ ok: true });
    expect(session.find((frame) => frame.id === "r2")).toMatchObject({ ok: true, result: { canvases: expect.any(Array) } });

    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "dark-paired.png") });
    await page.locator(".settings-panel__close").click();
    await openCompanion("bright");
    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "bright-paired.png") });

    // Remove: two steps, then the line and the phone are gone, and it is revoked.
    await page.getByRole("button", { name: "Remove E2E iPhone" }).click();
    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "bright-remove-confirm.png") });
    await page.getByTestId("companion-phone").getByRole("button", { name: "remove", exact: true }).click();
    await expect(page.getByTestId("companion-phone")).toHaveCount(0);
    expect(readFileSync(keysPath, "utf8")).toBe(`${OPERATOR_LINE}\n`);
    const revoked = await runPhone(sandbox.homeDir, deviceId, []);
    expect(revoked[0]).toMatchObject({ type: "response", id: "", ok: false, error: { code: "revoked" } });

    await page.getByRole("button", { name: "Pair a phone" }).click();
    await page.locator(".settings-panel").screenshot({ path: join(SHOTS, "bright-qr.png") });
    await page.getByRole("button", { name: "cancel" }).click();
  } finally {
    await junto.close();
  }
  expect(realKeysDigest()).toBe(realBefore);
});
