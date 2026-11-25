// Two machines, one window: the near app (this process, any host with a display) and a far install on a second
// machine over key SSH, with a stand-in seat there. Five lines, each recorded: the seat modal's Terminal and Threads
// switch on a far seat, the operator's new thread written in the window reaching the far seat, a far answer shown
// unread on the editing machine, a far signal in a thread reaching the operator feed, and the operator's reply in the
// window answering the far seat's signal.
//
// Gated: it runs only with RV_FAR_IP set (the far machine's address), so a full suite never dials anywhere.
//   RV_FAR_IP=<address> [RV_FAR_USER=user] [RV_SSH_KEY=~/rv-near-ssh/client_ed25519] [RV_KNOWN_HOSTS=~/rv-near-ssh/known_hosts]
//   VM_SEAT=<seat> scripts/vm.sh run <near VM> 'RV_FAR_IP=<far VM address> scripts/run-e2e.sh e2e/scenarios/rv-ui.spec.ts'
// The near needs dist/machines/<platform>-<arch> built from this same checkout, and key SSH to the far. The far needs
// nothing planted: the spec writes a stand-in `amp` and a `far.sh` into the far user's home, resets the far's install
// at the start and the end, and never touches the far's own ~/.junto.
// The stand-in is not the real amp: it answers --version and `threads new`, writes the seat's JUNTO_* variables
// (values with a single quote are not supported) to ~/rv-seat/env.sh, and sleeps. far.sh runs the far install's real `junto` with those variables, as the seat.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { card } from "../harness/canvas";
import { commandModel, modelFixture, modelNote, modelSeat } from "../harness/model";
import { crewPlayFactory } from "../harness/crew-fixture";
import { expect, test } from "../harness/launch";
import { mod } from "../harness/keys";

const run = promisify(execFile);
const HOME = process.env.HOME as string;
const REPO = process.cwd();
const FAR_USER = process.env.RV_FAR_USER ?? "user";
const TARGET = `${process.platform}-${process.arch}`;
const CLI = `${REPO}/dist/machines/${TARGET}/bin/junto`;
const OUT = join(REPO, "test-results", "rv-ui");
const LOG = `${OUT}/ui.log`;
const FAR_IP = process.env.RV_FAR_IP ?? "";
const KEY = process.env.RV_SSH_KEY ?? `${HOME}/rv-near-ssh/client_ed25519`;
const KNOWN = process.env.RV_KNOWN_HOSTS ?? `${HOME}/rv-near-ssh/known_hosts`;
test.skip(FAR_IP === "", "set RV_FAR_IP=<the far machine address> to run the two-machine window proof");
const log = (label: string, value: unknown): void => {
  const line = `[${new Date().toISOString()}] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};
const far = async (cmd: string): Promise<string> => {
  try {
    const r = await run("ssh", ["-i", KEY, "-o", `UserKnownHostsFile=${KNOWN}`, "-o", "BatchMode=yes", `${FAR_USER}@${FAR_IP}`, cmd], { timeout: 60_000, maxBuffer: 8 << 20 });
    return r.stdout.trim();
  } catch (e) { return `FAILED ${String((e as { stderr?: string }).stderr ?? e).slice(0, 600)}`; }
};

test.use({
  juntoOptions: {
    electronArgs: ["--junto-operator-control"],
    extraEnv: { JUNTO_MACHINE_BUNDLES: `${REPO}/dist/machines` },
    seedModels: { rv: modelFixture([modelNote("n1", "keep", 400, 0)]) },
  },
});

test("window items, near app and a far install", async ({ junto }) => {
  test.setTimeout(1_500_000);
  const { page, sandbox } = junto;
  mkdirSync(OUT, { recursive: true });
  const owner = async (args: string[], timeout = 600_000): Promise<string> => {
    try {
      const r = await run(CLI, args, { env: { HOME, PATH: "/usr/bin:/bin", JUNTO_HOME: sandbox.homeDir }, timeout, maxBuffer: 8 << 20 });
      return r.stdout.trim();
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      return `FAILED ${(x.stdout ?? "").trim()} ${(x.stderr ?? "").trim()}`.slice(0, 3000);
    }
  };
  const testids = (): Promise<string[]> => page.evaluate(() => [...new Set([...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid") ?? ""))].sort());
  const farHome = await far("echo $HOME");
  const AMP = `#!/bin/sh
# remote-verify stand-in, not the real amp: answers --version and "threads new", records this seat's JUNTO_* variables, idles.
mkdir -p "$HOME/rv-seat"
echo "$(date -u +%FT%TZ) argv: $*" >> "$HOME/rv-seat/starts.log"
case "$1" in --version|-v) echo "amp 0.0.0-remote-verify-standin"; exit 0;; esac
if [ "$1" = threads ] && [ "$2" = new ]; then echo "T-$(cat /proc/sys/kernel/random/uuid)"; exit 0; fi
umask 077
env | grep "^JUNTO_" | sed "s/^\\([A-Za-z0-9_]*\\)=\\(.*\\)$/export \\1='\\2'/" > "$HOME/rv-seat/env.sh"
exec sleep 7200
`;
  const FAR_SH = `#!/bin/sh
set -a; . "$HOME/rv-seat/env.sh"; set +a
exec "$HOME/rv-far/machine/current/bin/junto" "$@"
`;
  const plant = (path: string, text: string, mode: string): Promise<string> => far(`mkdir -p "$(dirname ${path})" && echo ${Buffer.from(text).toString("base64")} | base64 -d > ${path} && chmod ${mode} ${path}`);
  log("00 plant stand-in amp and far.sh", [await plant("$HOME/.local/bin/amp", AMP, "755"), await plant("$HOME/far.sh", FAR_SH, "700")]);
  const resetFar = (): Promise<string> => far(`C=$HOME/rv-far/machine/current; if [ -x $C/bin/node ]; then env -i HOME=$HOME PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus JUNTO_HOME=$HOME/rv-far JUNTO_NATIVE_CLI=$C/bin/junto $C/bin/node $C/core/machine-local.cjs uninstall-local "{\\"juntoHome\\":\\"$HOME/rv-far\\",\\"installRoot\\":\\"$HOME/rv-far/machine\\"}" 2>&1 | cut -c1-200; fi; rm -rf ~/rv-far ~/rv-seat; echo units: $(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user list-units --no-legend "dev.junto.machine.*" | wc -l)`);
  log("0 reset far", await resetFar());
  await card(page, "n1").visible({ timeout: 60_000 });
  log("1 machine add", (await owner(["machine", "add", JSON.stringify({ name: "rv-far", sshTarget: `${FAR_USER}@${FAR_IP}`, sshIdentityFile: KEY, sshKnownHostsFile: KNOWN, juntoHome: `${farHome}/rv-far`, installRoot: `${farHome}/rv-far/machine` })])).slice(0, 300));
  log("2 machine send", (await owner(["machine", "send", JSON.stringify({ name: "rv-far" })])).slice(0, 500));
  log("3 machine status", (await owner(["machine", "status", JSON.stringify({ name: "rv-far" })])).slice(0, 200));
  const seat = modelSeat({ id: "s1", key: "rv-far:s1", bindingId: "rv-far:s1", host: "rv-far", harness: "amp", cwd: "/tmp", launch: { kind: "harness", argv: ["amp"], cwd: "/tmp" } as never, x: 0, y: 0 });
  log("4 place seat", await commandModel(page, { _tag: "Batch", canvas: "rv", steps: [{ _tag: "Add", canvas: "rv", nodes: [seat], wires: [] }] }).then((r) => JSON.stringify(r).slice(0, 200), (e: unknown) => "ERR " + String(e).slice(0, 300)));
  await card(page, "s1").visible({ timeout: 30_000 });
  await crewPlayFactory(page);
  log("5 seat-start", (await owner(["machine", "seat-start", "rv", "s1"])).slice(0, 400));
  await page.waitForTimeout(5_000);
  log("6 far seat env", await far("ls -la ~/rv-seat; tail -2 ~/rv-seat/starts.log"));
  await page.screenshot({ path: `${OUT}/ui-1-seat-started.png` });
  const lines: Array<{ id: string; pass: boolean; note: string }> = [];
  const line = (id: string, pass: boolean, note: string): void => { lines.push({ id, pass, note }); log(`LINE ${id} ${pass ? "PASS" : "FAIL"}`, note); };
  const farJson = async (cmd: string): Promise<any> => { const out = await far(cmd); try { return JSON.parse(out); } catch { return { raw: out.slice(0, 400) }; } };
  const feedLabel = async (): Promise<string> => (await page.getByTestId("operator-feed-trigger").evaluate((e) => `${e.getAttribute("aria-label") ?? ""} | ${(e.textContent ?? "").trim()}`).catch(() => "none"));
  const seatSurface = page.locator('[data-testid="native-terminal-surface"]').first();

  // 1: the seat modal's switch, on a far seat
  await card(page, "s1").dblclick();
  await page.waitForTimeout(3_000);
  const stageVisible = (): Promise<boolean> => page.locator("#seat-stage-s1").isVisible().catch(() => false);
  const terminalFirst = await stageVisible();
  await seatSurface.getByTestId("seat-view-threads").click();
  await expect(seatSurface.getByTestId("seat-threads")).toBeVisible({ timeout: 10_000 });
  const threadsShown = await seatSurface.getByTestId("seat-threads").isVisible();
  await seatSurface.getByTestId("seat-view-terminal").click();
  await page.waitForTimeout(1_000);
  const threadsGone = await seatSurface.getByTestId("seat-threads").isHidden();
  line("modal-switch", terminalFirst && threadsShown && threadsGone, `terminal first ${terminalFirst}; threads view shown ${threadsShown}; back to terminal, threads hidden ${threadsGone}`);
  await page.screenshot({ path: `${OUT}/ui-2-switch.png` });

  // 2: the operator writes to the far seat through the window
  const feed0 = await feedLabel();
  await seatSurface.getByTestId("seat-view-threads").click();
  await seatSurface.getByTestId("seat-threads-new").click();
  const text1 = "Ship it today? (window send, remote-verify)";
  const input = seatSurface.getByTestId("thread-composer-input");
  await input.fill(text1);
  await seatSurface.getByTestId("thread-composer-send").click();
  await expect(seatSurface.getByTestId("seat-threads-message").filter({ hasText: text1 })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${OUT}/ui-3-sent.png` });
  let farThreads: any = {};
  await expect.poll(async () => { farThreads = await farJson("~/far.sh thread list"); return farThreads?.data?.threads?.length ?? 0; }, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(0);
  const T = farThreads.data.threads[0].threadId as string;
  const farHas = JSON.stringify(farThreads).includes("Ship it today");
  line("send-window-to-far", farHas, `the far seat lists thread ${T}, text arrived: ${farHas}`);

  // 3: the far seat answers; unread on the editing machine
  await page.getByRole("button", { name: "CLOSE" }).first().click();
  await page.waitForTimeout(1_500);
  const modalClosed = (await page.locator('[data-testid="native-terminal-surface"]').count()) === 0;
  log("seat modal closed before the far answers", modalClosed);
  await page.mouse.click(700, 500);
  const unreadBefore = await feedLabel();
  const shown = await farJson(`~/far.sh thread show ${T}`);
  const opMsg = shown?.data?.messages?.[0]?.messageId as string;
  const reply = await farJson(`~/far.sh msg reply '{"target":"operator","text":"Yes, today. (far answer)","inReplyTo":"${opMsg}"}'`);
  log("far reply", JSON.stringify(reply).slice(0, 200));
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: `${OUT}/ui-4-after-answer.png` });
  await page.keyboard.press(mod("U"));
  await page.waitForTimeout(2_000);
  const chip = await page.getByTestId("threads-unread-chip").getAttribute("aria-label").catch(() => null);
  const unreadRows = await page.getByTestId("operator-threads-row-unread").count().catch(() => -1);
  const rowsText = await page.getByTestId("operator-threads-row").evaluateAll((all) => all.map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120))).catch(() => []);
  await page.screenshot({ path: `${OUT}/ui-5-global-threads.png` });
  line("far-answer-unread", modalClosed && unreadRows >= 1 && /1/.test(chip ?? ""), `feed before "${feed0}" after-answer "${await feedLabel()}"; threads unread chip "${chip}"; unread rows ${unreadRows}; rows ${JSON.stringify(rowsText)}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // 4: a far signal in the thread reaches the operator feed
  const sig = await farJson(`~/far.sh escalate 'RV window signal: which region first?' --thread ${T}`);
  log("far escalate", JSON.stringify(sig).slice(0, 260));
  await page.waitForTimeout(6_000);
  const feedAfter = await feedLabel();
  await page.getByTestId("operator-feed-trigger").click().catch(() => undefined);
  await page.waitForTimeout(1_500);
  const feedText = (await page.evaluate(() => document.body.innerText)).slice(0, 700);
  await page.screenshot({ path: `${OUT}/ui-6-feed.png` });
  line("far-signal-in-feed", /region first/i.test(feedText), `feed trigger before "${feed0}" after "${feedAfter}"; feed shows the signal: ${/region first/i.test(feedText)}`);
  log("feed text", feedText);
  await page.keyboard.press("Escape");

  // 5: the operator answers in the thread through the window; the far seat sees it answered
  await card(page, "s1").dblclick();
  await page.waitForTimeout(2_000);
  await seatSurface.getByTestId("seat-view-threads").click();
  await seatSurface.getByTestId("seat-threads-row").first().click().catch(() => undefined);
  const text2 = "EU first. (window answer, remote-verify)";
  await seatSurface.getByTestId("thread-composer-input").fill(text2);
  await seatSurface.getByTestId("thread-composer-send").click();
  await expect(seatSurface.getByTestId("seat-threads-message").filter({ hasText: text2 })).toBeVisible({ timeout: 15_000 });
  let answered = false;
  await expect.poll(async () => { const l = await farJson("~/far.sh signal list"); answered = (l?.data?.signals ?? []).some((x: any) => x.state === "answered"); return answered; }, { timeout: 60_000, intervals: [1000] }).toBe(true).catch(() => undefined);
  line("answer-window-to-far", answered, `the far seat's signal list shows it answered: ${answered}`);

  log("LINES", lines);
  log("99 reset far", await resetFar());
  expect(lines.filter((l) => !l.pass).map((l) => l.id)).toEqual([]);
});
