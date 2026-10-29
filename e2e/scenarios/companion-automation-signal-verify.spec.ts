/**
 * An automation's signal on the companion wire (9aa91f0dd): the phone gets
 * seat.get, feed.subscribe and signal.changed with no source.step, while the
 * desktop keeps the step and its raised values. A stand-in phone is the real
 * `junto companion-stdio --device` relay, paired as in companion-pairing.spec.
 *
 *   scripts/with-app-run-lock.sh sh -c 'JUNTO_FEATURE_PROFILE=all-on electron-vite build && scripts/run-e2e.sh e2e/scenarios/companion-automation-signal-verify.spec.ts'
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Region } from "../../src/shared/model";
import { modelFixture, modelNode, modelRegion, modelSeat, type ModelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "companion-automation";
const SEAT = "lead";
const NODE = "routines";
const AUTOMATION_ID = "01M62Q58WDSXMG4YBXNKR2RB91";
const FIRING_ID = "01M62Q58WDSXMG4YBXNKR2RB92";
const PHONE_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBE2eFakePhoneKeyForE2E=";
const RAISED_VALUE = "RAISED-VALUE-MARKER-" + "x".repeat(900);

const fixture = (): ModelFixture =>
  modelFixture([
    modelRegion({ id: "writing", label: "Writing", color: "5", x: 0, y: 0, width: 1000, height: 500 }) as Region,
    modelSeat({ id: SEAT, key: "local:e2e-companion-automation-lead", label: "lead", x: 40, y: 340 }),
    modelNode({ kind: "automations", id: NODE, label: "Routines", x: 40, y: 60, width: 260, height: 120, z: 1 }),
  ]);

const signal: AgentSignal = {
  signalId: "sig-step",
  canvasName: CANVAS,
  nodeId: SEAT,
  kind: "escalate",
  text: "Which post goes out first?",
  createdAt: Date.now() - 10 * 60_000,
  state: "open",
  source: {
    kind: "automation",
    automationId: AUTOMATION_ID,
    nodeId: NODE,
    firingId: FIRING_ID,
    step: { index: 2, id: "ask", raised: { draft: RAISED_VALUE, other: "second-raised-value" } },
  },
};

const request = (id: string, op: string, args: object = {}): string =>
  JSON.stringify({ v: "junto-companion/1", type: "request", id, op, args });

/** Holds the relay open: sends `lines`, then `afterReply` once its id answers, and ends when `done` holds. */
const phoneSession = (
  home: string,
  deviceId: string,
  lines: ReadonlyArray<string>,
  step?: { readonly after: string; readonly run: () => Promise<void> },
  done: (frames: ReadonlyArray<Record<string, any>>) => boolean = () => false,
) =>
  new Promise<{ readonly raw: string; readonly frames: ReadonlyArray<Record<string, any>> }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    // A phone is no seat: none of this seat's own JUNTO_* identity reaches the relay.
    for (const key of Object.keys(env)) if (key.startsWith("JUNTO_")) delete env[key];
    const child = spawn("bun", [join(process.cwd(), "src/cli/main.ts"), "companion-stdio", "--device", deviceId], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let ran = false;
    const parse = () => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      let frames: Array<Record<string, any>>;
      try { frames = parse(); } catch { return; }
      if (step && !ran && frames.some((frame) => frame.id === step.after)) {
        ran = true;
        void step.run().catch(reject);
      }
      if (done(frames)) child.stdin.end();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ raw: out, frames: parse() }));
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => child.kill(), 60_000);
  });

test("an automation signal reaches the phone without its step and stays whole on the desktop", async () => {
  test.setTimeout(300_000);
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
    seedModels: { [CANVAS]: fixture() },
    seedAgentSignals: [signal],
    extraEnv: { JUNTO_E2E_COMPANION_ENVIRONMENT: JSON.stringify(environment) },
    afterSeed: async (sandbox) => {
      mkdirSync(join(sandbox.homeDir, ".ssh"), { recursive: true, mode: 0o700 });
      writeFileSync(join(sandbox.homeDir, ".ssh", "authorized_keys"), "", { mode: 0o600 });
      // The harness seeds no source column: put the automation's source, step and all, where the app reads it.
      const runtime = ManagedRuntime.make(makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")));
      try {
        const sql = await runtime.runPromise(SqlClient.SqlClient);
        await runtime.runPromise(sql`UPDATE agent_signals SET source_json = ${JSON.stringify(signal.source)} WHERE signal_id = ${signal.signalId}`.pipe(Effect.asVoid));
      } finally { await runtime.dispose(); }
    },
  });
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    // Pair the stand-in phone (a scratch HOME's authorized_keys, never the operator's).
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Companion" }).click();
    await page.getByRole("button", { name: "Pair a phone" }).click();
    await expect(page.getByTestId("companion-pairing").getByRole("img")).toBeVisible();
    const devices = await page.evaluate(() => window.junto!.companionDevices!());
    const deviceId = devices.find((device) => device.state === "pairing")!.deviceId;
    const paired = await phoneSession(sandbox.homeDir, deviceId, [request("p1", "pair.complete", { publicKey: PHONE_KEY, deviceName: "E2E iPhone" })], undefined, (frames) =>
      frames.some((frame) => frame.id === "p1"));
    expect(paired.frames.find((frame) => frame.id === "p1")).toMatchObject({ ok: true });
    await page.locator(".settings-panel__close").click();

    // The desktop holds the step and every raised value.
    const desktop = await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);
    const held = desktop.find((candidate) => candidate.signalId === "sig-step");
    expect(held?.source).toMatchObject({ kind: "automation", step: { index: 2, id: "ask", raised: { draft: RAISED_VALUE, other: "second-raised-value" } } });

    // The phone: subscribe, open the seat, then the desktop answers and signal.changed follows.
    const session = await phoneSession(
      sandbox.homeDir,
      deviceId,
      [request("sub", "feed.subscribe", {}), request("seat", "seat.get", { canvasName: CANVAS, nodeId: SEAT })],
      { after: "seat", run: () => page.evaluate(() => window.junto!.agentSignalRespond("sig-step", "Yes", {})).then(() => undefined) },
      (frames) => frames.some((frame) => frame.type === "event" && frame.event === "signal.changed"),
    );

    const seat = session.frames.find((frame) => frame.id === "seat");
    expect(seat).toMatchObject({ ok: true });
    const onSeat = seat!.result.seat.signals.find((candidate: AgentSignal) => candidate.signalId === "sig-step");
    expect(onSeat?.source).toMatchObject({ kind: "automation", automationId: AUTOMATION_ID, firingId: FIRING_ID });
    expect(onSeat.source).not.toHaveProperty("step");

    const changed = session.frames.filter((frame) => frame.type === "event" && frame.event === "signal.changed");
    expect(changed.length).toBeGreaterThan(0);
    for (const frame of changed) expect(frame.data.signal.source).not.toHaveProperty("step");

    // No frame of the whole conversation carries a step or a raised value.
    expect(session.raw).not.toContain("RAISED-VALUE-MARKER");
    expect(session.raw).not.toContain("second-raised-value");
    expect(session.raw).not.toContain('"raised"');
    mkdirSync(join(process.cwd(), "test-results", "companion-automation"), { recursive: true });
    writeFileSync(join(process.cwd(), "test-results", "companion-automation", "frames.ndjson"), session.raw);

    // The desktop still holds the step after the answer.
    const after = await page.evaluate((canvas) => window.junto!.agentSignalsList(canvas), CANVAS);
    expect(after.find((candidate) => candidate.signalId === "sig-step")?.source).toMatchObject({ step: { raised: { draft: RAISED_VALUE } } });
  } finally {
    await junto.close();
  }
});
