/**
 * The phone's artifact and thread ops against a real app (0.11.3): a stand-in
 * phone is the real `junto companion-stdio --device` relay, paired through the
 * app, and walks e2e/harness/companion-walk.ts. The desktop's edits go through
 * the window API, the seats are the harness's stand-in seats with the real CLI.
 * Every frame is written to $COMPANION_TRANSCRIPT (default
 * test-results/companion-artifacts/transcript.ndjson), and the step table next to it.
 *
 *   scripts/with-app-run-lock.sh sh -c 'JUNTO_FEATURE_PROFILE=all-on electron-vite build && scripts/run-e2e.sh e2e/scenarios/companion-artifacts-verify.spec.ts'
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { Phone, ulid, walk } from "../harness/companion-walk";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat, modelWire } from "../harness/model";

const CANVAS = "companion-artifacts";
const NODE = "shelf";
const PHONE_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBE2eFakePhoneKeyForE2E=";
const OUT = process.env.COMPANION_TRANSCRIPT ?? join(process.cwd(), "test-results", "companion-artifacts", "transcript.ndjson");

/** A phone is no seat: none of this seat's JUNTO_* identity reaches the relay. */
const phoneEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("JUNTO_")) delete env[key];
  return env;
};

test("the phone walks artifacts, comments, mentions, threads and a signal answer against the real app", async () => {
  test.setTimeout(480_000);
  const scout = modelSeat({ id: "scout", key: "local:cav-scout", label: "Scout", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-cav-scout-")), x: 40, y: 60 });
  const ada = modelSeat({ id: "ada", key: "local:cav-ada", label: "Ada", harness: "codex", cwd: mkdtempSync(join(tmpdir(), "junto-cav-ada-")), x: 300, y: 60 });
  const nodes = [
    modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 900, height: 420 }),
    scout,
    ada,
    modelNode({ kind: "artifacts", id: NODE, label: "Shelf", x: 560, y: 60, width: 260, height: 140, z: 0 }),
  ];
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
    windowContentSize: { width: 1400, height: 860 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-scout-ada", "scout", "ada", "messages", nodes)]) },
    extraEnv: { JUNTO_E2E_COMPANION_ENVIRONMENT: JSON.stringify(environment) },
    afterSeed: async (sandbox) => {
      await installCrewSeatHarness(sandbox);
      mkdirSync(join(sandbox.homeDir, ".ssh"), { recursive: true, mode: 0o700 });
      writeFileSync(join(sandbox.homeDir, ".ssh", "authorized_keys"), "", { mode: 0o600 });
    },
  });
  let phone: Phone | undefined;
  try {
    const { page, sandbox } = junto;
    await expect(page.locator(`.react-flow__node[data-id="${NODE}"]`)).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    const scoutSeat = crewSeat(sandbox, CANVAS, "scout");
    await crewOccupySeat(page, CANVAS, scout, scoutSeat);
    expect((await scoutSeat.op("onboard", {})).ok, "scout onboards").toBe(true);

    // Pair the stand-in phone through the app (a scratch HOME; never the operator's authorized_keys).
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Companion" }).click();
    await page.getByRole("button", { name: "Pair a phone" }).click();
    await expect(page.getByTestId("companion-pairing").getByRole("img")).toBeVisible();
    const devices = await page.evaluate(() => window.junto!.companionDevices!());
    const deviceId = devices.find((device) => device.state === "pairing")!.deviceId;
    const pairing = new Phone(["--device", deviceId], process.cwd(), phoneEnv(sandbox.homeDir));
    expect((await pairing.call("pair.complete", { publicKey: PHONE_KEY, deviceName: "E2E iPhone" })).ok).toBe(true);
    pairing.close();
    await page.locator(".settings-panel__close").click();

    phone = new Phone(["--device", deviceId], process.cwd(), phoneEnv(sandbox.homeDir));
    const results = await walk(phone, {
      canvas: CANVAS,
      node: NODE,
      seat: "ada",
      signalSeat: "scout",
      hooks: {
        desktopReplace: async (artifactId, markdown) => {
          await page.evaluate(async ([canvas, node, id, text, opId]) => {
            const api = window.junto!.resource.artifact;
            const head = (await api.list(canvas, node as never)).find((row) => row.artifact.artifactId === id)?.artifact;
            if (head === undefined) throw new Error("artifact not on the desktop");
            const outcome = await api.apply(canvas, node as never, id as never, opId as never, {
              op: "edit",
              edit: { kind: "replace", baseVersion: head.version, body: { type: "document", markdown: text } },
            } as never);
            if (outcome.kind !== "applied") throw new Error(`desktop edit ${outcome.kind}`);
          }, [CANVAS, NODE, artifactId, markdown, ulid()] as const);
        },
        desktopLargeDocument: async () => {
          const id = ulid();
          await page.evaluate(async ([canvas, node, artifactId, opId]) => {
            const markdown = `${"large document line, repeated to pass the frame budget\n".repeat(9_000)}`;
            const outcome = await window.junto!.resource.artifact.apply(canvas, node as never, artifactId as never, opId as never, {
              op: "create", title: "Large document", body: { type: "document", markdown },
            } as never);
            if (outcome.kind !== "applied") throw new Error(`large create ${outcome.kind}`);
          }, [CANVAS, NODE, id, ulid()] as const);
          return id;
        },
        peerMail: async (text) => {
          const sent = await scoutSeat.cli(["msg", "send", JSON.stringify({ target: "Ada", text })]);
          expect(sent.exitCode, sent.stderr.slice(0, 300)).toBe(0);
        },
        desktopReadThread: async (nodeId, threadId) => {
          await page.evaluate(([canvasName, node, thread]) => window.junto!.seatThreadMarkRead({ canvasName, nodeId: node as never, threadId: thread as never }), [CANVAS, nodeId, threadId] as const);
        },
        raiseArtifactSignal: async (text, minWords) => {
          const raised = await scoutSeat.cli(["escalate", text, "--ask-artifact", NODE, "--min-words", String(minWords)]);
          expect(raised.exitCode, raised.stderr.slice(0, 300)).toBe(0);
        },
      },
    });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${phone.transcript.map((line) => JSON.stringify(line)).join("\n")}\n`);
    writeFileSync(OUT.replace(/\.ndjson$/, ".steps.json"), `${JSON.stringify(results, null, 2)}\n`);
    for (const row of results) console.log(`${row.status.toUpperCase().padEnd(4)} ${row.step}${row.detail === undefined ? "" : `  (${row.detail})`}`);
    expect(results.filter((row) => row.status === "fail"), "failed steps").toEqual([]);
  } finally {
    phone?.close();
    await junto.close();
  }
});
