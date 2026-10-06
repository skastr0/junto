/**
 * PTY team checklist walk [fake-tui]: one test per checklist line, named by
 * its line id (A2 to A5, B1 to B5). Lines A1 and A6 need real harness CLIs
 * and are not here.
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-session-checklist.spec.ts
 *
 * Every seat is the crew fixture's fake codex (e2e/harness/crew-fixture.ts):
 * it paints the real codex screens, logs the bytes its PTY input receives,
 * and proxies real work-control calls with its own process-bound identity.
 * No real harness binary is started, no Keychain item is read or written
 * (line B3 looks up a made-up service name that does not exist), and every
 * file the walk creates lives under os.tmpdir() or the launch sandbox.
 *
 * Two honest limits of fake seats, both stated where they bite:
 *
 *  - A fake seat is not a shell, so `echo "$FOO"` cannot be typed into it.
 *    The walk plants a three-line wrapper in front of the fake that records,
 *    at every launch, what `echo "$FOO"` would print in that seat (the seat
 *    process environment), then becomes the fake. See installWalkSeatHarness.
 *  - `junto ...` runs through the fake's CLI proxy (CrewSeat.cli), which
 *    needs the standalone CLI at dist/junto (`bun run cli:build`). Where a
 *    line only needs what the command returns, the walk falls back to the
 *    same work-control op and says so in a test annotation. Line B3 needs the
 *    CLI's exit code and fails with a SETUP message when dist/junto is absent.
 *
 * Evidence: each line screenshots its key moment into the test's output
 * folder, screenshots again when it fails, and asserts text it can show
 * (the terminal's visible rows, the seat's PTY input, the screen's own copy)
 * so the Playwright error prints what was received.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { CanvasDoc, EnvSource, GroupNode, TextNode } from "../../src/shared/canvas";
import { buildOnboardNudge } from "../../src/shared/managed-terminal-injection";
import { MAIL_ONBOARD_POINTER } from "../../src/shared/message-delivery";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import {
  crewDoc,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewReceipts,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type CrewCliResult,
  type CrewSeat,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle, type LaunchOptions } from "../harness/launch";
import type { Sandbox } from "../harness/sandbox";

// Only [A-Za-z0-9._-] in the canvas name and node ids: the env wrapper names
// its log after JUNTO_NODE_REF (`<canvas>:<nodeId>`).
const CANVAS = "ptywalk";

/** The standalone CLI the fake seat's `cli` proxy runs (seat-env.ts injects JUNTO_CLI from it). */
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing, so a fake seat cannot run the junto CLI. Build it with `bun run cli:build` in the checkout the run starts from.";

/** The open (not parked) terminal surface, as mail-wakes-cold-seat.spec.ts finds it. */
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

// ---------------------------------------------------------------------------
// Launch, evidence
// ---------------------------------------------------------------------------

const shot = async (page: Page, testInfo: TestInfo, name: string): Promise<void> => {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
};

/**
 * One app per line. A failure leaves a screenshot of what was on screen
 * before the app is closed (the config's own failure screenshot follows
 * Playwright's page fixture, not the Electron window).
 */
function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

const walk = async (
  testInfo: TestInfo,
  options: LaunchOptions,
  body: (junto: JuntoHandle) => Promise<void>,
): Promise<void> => {
  const junto = await launchJunto(options);
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await body(junto);
  } catch (error) {
    await junto.page.screenshot({ path: testInfo.outputPath("on-failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    // Keep the delivery trace: the sandbox is deleted on close.
    const keep = process.env.PTY_WALK_TRACE_DIR;
    if (keep) {
      const { cpSync, existsSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const logs = join(junto.sandbox.homeDir, ".junto", "logs");
      const dest = join(keep, testInfo.title.slice(0, 2));
      mkdirSync(dest, { recursive: true });
      const { writeFileSync, readdirSync } = await import("node:fs");
      if (existsSync(logs)) cpSync(logs, join(dest, "logs"), { recursive: true });
      const state = join(junto.sandbox.homeDir, ".junto");
      writeFileSync(join(dest, "listing.txt"), `logs exists=${existsSync(logs)}\n.junto: ${existsSync(state) ? readdirSync(state).join(", ") : "absent"}\nlogs: ${existsSync(logs) ? readdirSync(logs).join(", ") : "absent"}\n`);
      note(testInfo, "trace", `logs dir ${logs} exists=${existsSync(logs)}`);
    }
    await junto.close();
  }
};


// ---------------------------------------------------------------------------
// Fake seat harness, with the env record in front of it
// ---------------------------------------------------------------------------

/** The names the wrapper records at every seat launch. */
const RECORDED_NAMES = ["FOO", "WALK_FROM_FILE", "WALK_OUTER_ONLY"] as const;
type RecordedName = (typeof RECORDED_NAMES)[number];
const UNSET = "__unset__";

const envLogDir = (sandbox: Sandbox): string => join(sandbox.root, "pty-walk-env");

/**
 * The crew fixture's fake codex, behind a wrapper that appends one line per
 * launch: what `echo "$NAME"` would print in this seat for each recorded
 * name, or __unset__. Then it execs the fake, so the seat process is the
 * fake itself (same pid, same process-bound identity).
 */
const installWalkSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  await installCrewSeatHarness(sandbox);
  const bin = seededHarnessBinDir(sandbox);
  const fake = join(bin, "codex-crew-fake");
  await rename(join(bin, "codex"), fake);
  const logs = envLogDir(sandbox);
  await mkdir(logs, { recursive: true });
  const script = [
    "#!/bin/sh",
    "# [fake-tui] seat-session-checklist: record the seat environment, then become the crew fake.",
    'if [ -n "${JUNTO_NODE_REF:-}" ]; then',
    "  ref=$(printf '%s' \"$JUNTO_NODE_REF\" | tr -c 'A-Za-z0-9._-' '_')",
    "  {",
    "    printf 'launch'",
    `    for name in ${RECORDED_NAMES.join(" ")}; do`,
    `      eval "value=\\\${$name-${UNSET}}"`,
    "      printf '\\t%s=%s' \"$name\" \"$value\"",
    "    done",
    "    printf '\\n'",
    `  } >> '${logs}'/"$ref.log"`,
    "fi",
    `exec '${fake}' "$@"`,
    "",
  ].join("\n");
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, script, "utf8");
  await chmod(wrapper, 0o755);
};

type SeatEnvRecord = Readonly<Record<RecordedName, string>>;

/** One record per launch of this seat, oldest first. */
const seatLaunches = async (sandbox: Sandbox, nodeId: string): Promise<ReadonlyArray<SeatEnvRecord>> => {
  const raw = await readFile(join(envLogDir(sandbox), `${CANVAS}_${nodeId}.log`), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.startsWith("launch"))
    .map((line) => {
      const pairs = line
        .split("\t")
        .slice(1)
        .map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)] as const;
        });
      return Object.fromEntries(pairs) as SeatEnvRecord;
    });
};

const bindingOf = (nodeId: string): string => `local:${nodeId}`;

const seatState = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingOf(nodeId))?.state;
};

const expectSeatState = async (page: Page, nodeId: string, state: string | RegExp): Promise<void> => {
  // "none" until main has a state for the seat, so a miss prints a word.
  const poll = expect.poll(async () => (await seatState(page, nodeId)) ?? "none", {
    message: `seat ${nodeId} state`,
    timeout: 30_000,
  });
  if (typeof state === "string") await poll.toBe(state);
  else await poll.toMatch(state);
};

/** Play the canvas, start the seat's fake, and wait until it reads idle. */
const startSeat = async (junto: JuntoHandle, node: TextNode): Promise<CrewSeat> => {
  const seat = crewSeat(junto.sandbox, CANVAS, node.id);
  await crewOccupySeat(junto.page, CANVAS, node, seat);
  await expectSeatState(junto.page, node.id, "idle");
  return seat;
};

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

const cliText = (result: CrewCliResult): string => `${result.stdout}${result.stderr}`;

const cliJson = (result: CrewCliResult): unknown => {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return undefined;
  }
};

/** Every object anywhere in `value`, the value itself included. */
const records = (value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    for (const item of value) records(item, out);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    out.push(record);
    for (const item of Object.values(record)) records(item, out);
  }
  return out;
};

type SourceRow = {
  readonly regionId: string;
  readonly kind: string;
  readonly names: ReadonlyArray<string>;
  readonly status: string;
  readonly reason?: string;
  readonly required?: boolean;
};

/** The report's source rows, wherever they sit in a result (shared/region-environment.ts SourceReport). */
const sourceRows = (value: unknown): ReadonlyArray<SourceRow> =>
  records(value).filter(
    (record) => typeof record.sourceId === "string" && Array.isArray(record.names),
  ) as unknown as ReadonlyArray<SourceRow>;

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// The seat's terminal, as the operator sees and types into it
// ---------------------------------------------------------------------------

const seatCard = (page: Page, nodeId: string): Locator => page.locator(`.react-flow__node[data-id="${nodeId}"]`);

const openSeatTerminal = async (page: Page, nodeId: string): Promise<Locator> => {
  await seatCard(page, nodeId).dblclick();
  const surface = page.locator(SURFACE);
  await expect(surface).toBeVisible({ timeout: 30_000 });
  return surface;
};

/** Put the keyboard in the terminal, and prove it is there before typing. */
const focusSeatTerminal = async (page: Page, surface: Locator): Promise<void> => {
  await surface.locator(".xterm-screen").click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null), {
      message: "the keyboard is in the terminal",
    })
    .toBe(true);
};

const closeSeatTerminal = async (page: Page, surface: Locator): Promise<void> => {
  await surface.getByRole("button", { name: "Close view" }).first().click();
  await expect(page.locator(SURFACE)).toHaveCount(0);
};

/** The open terminals' visible rows. Under WebGL the DOM carries no text, so read the test registry (TerminalSurface.tsx:1034). */
const screenText = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const registry = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText;
    return registry ? Array.from(registry.values(), (read) => read()).join("\n") : "";
  });

// A long line wraps across rows, and a wrap can fall on a space: compare with
// all whitespace removed. A miss prints the screen as it was read.
const squash = (text: string): string => text.replace(/\s+/g, "");

const expectOnScreen = async (page: Page, needle: string, what: string, timeout = 30_000): Promise<void> => {
  await expect
    .poll(async () => squash(await screenText(page)), { message: `on the seat's screen: ${what}`, timeout })
    .toContain(squash(needle));
};

// ---------------------------------------------------------------------------
// Regions and their Environment screen
// ---------------------------------------------------------------------------

const regionNode = (input: {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sources?: ReadonlyArray<EnvSource>;
}): GroupNode => ({
  id: input.id,
  type: "group",
  label: input.label,
  x: input.x,
  y: input.y,
  width: input.width,
  height: input.height,
  ether: {
    region: {
      hold: true,
      ...(input.sources ? { environment: { sources: [...input.sources] } } : {}),
    },
  },
});

const plainValue = (id: string, name: string, value: string): EnvSource => ({ id, kind: "value", name, value });

/** Select the region by its title bar and open Environment from its toolbar (the key icon). */
const openRegionEnvironment = async (page: Page, regionId: string): Promise<Locator> => {
  const region = page.getByTestId(`rf__node-${regionId}`);
  await expect(region).toBeVisible({ timeout: 30_000 });
  await region.locator(".region-drag-handle").first().click();
  const open = page.getByRole("button", { name: /^Region environment/ });
  await expect(open).toBeVisible({ timeout: 10_000 });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Region environment" });
  await expect(dialog.getByTestId("region-env")).toBeVisible();
  return dialog;
};

const closeRegionEnvironment = async (dialog: Locator): Promise<void> => {
  await dialog.getByRole("button", { name: "done", exact: true }).click();
  await expect(dialog).toBeHidden();
};

/** Add one source through the form: pick the kind, fill its fields, save. */
const addSource = async (
  dialog: Locator,
  kind: EnvSource["kind"],
  fields: Readonly<Record<string, string>>,
  options?: { readonly required?: boolean },
): Promise<void> => {
  await dialog.getByTestId("region-env-add-source").click();
  const form = dialog.getByTestId("region-env-form");
  await form.getByTestId(`region-env-kind-${kind}`).click();
  await expect(form).toHaveAttribute("data-kind", kind);
  for (const [key, value] of Object.entries(fields)) {
    await form.getByTestId(`region-env-field-${key}`).fill(value);
  }
  if (options?.required === true) {
    const required = form.getByRole("switch", { name: "Required" });
    await required.click();
    await expect(required).toBeChecked();
  }
  await form.getByTestId("region-env-save-source").click();
  await expect(form).toHaveCount(0);
};

/** One name in "What a seat here gets". */
const variable = (dialog: Locator, name: string): Locator =>
  dialog.locator(`[data-testid="region-env-variable"][data-name="${name}"]`);

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "junto-pty-walk-"));

// ===========================================================================
// A. Seats
// ===========================================================================

const ADA = crewSeatNode({ id: "seat-a", label: "Ada", x: 120, y: 220 });
const BO = crewSeatNode({ id: "seat-b", label: "Bo", x: 480, y: 220 });
const pairDoc = crewDoc([ADA, BO], [crewMessagesEdge("e-ab", ADA.id, BO.id, [ADA, BO])]);

test("A2 [fake-tui] the onboarding nudge follows a first message, at most twice, and stops once the seat runs junto onboard", async ({}, testInfo) => {
  test.setTimeout(480_000);
  const NUDGE = buildOnboardNudge();
  // Learner onboards after its first nudge; Stray never does.
  const learner = crewSeatNode({ id: "learner", label: "Learner", x: 120, y: 220 });
  const stray = crewSeatNode({ id: "stray", label: "Stray", x: 480, y: 220 });

  await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([learner, stray]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page } = junto;
    await crewPlayFactory(page);
    const seats = { learner: await startSeat(junto, learner), stray: await startSeat(junto, stray) };
    const mark = (nodeId: string): Locator => seatCard(page, nodeId).getByTestId("agent-seat-onboarding");

    // Type a first message into each seat. Nothing has been typed into
    // either before it: Junto sends nothing at session start.
    for (const node of [learner, stray]) {
      const seat = seats[node.id as "learner" | "stray"];
      const first = `first message for ${node.id}`;
      await expect(mark(node.id), `${node.id} card before onboarding`).toHaveText("Not onboarded", { timeout: 30_000 });
      await expect(mark(node.id)).toHaveAttribute("data-onboarding", "not-onboarded");
      expect(await seat.stdinLog(), `${node.id} was nudged before its first message`).not.toContain(NUDGE);

      const surface = await openSeatTerminal(page, node.id);
      await focusSeatTerminal(page, surface);
      await page.keyboard.type(first);
      // The draft is on the seat's screen (and seen as a draft) before it is sent.
      await expectOnScreen(page, first, "the typed first message, as a draft");
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
      await expectSeatState(page, node.id, "working");

      // The nudge arrives after it, on the seat's input and on its screen.
      await expect
        .poll(() => seat.stdinLog(), { message: `${node.id} PTY input after the first message`, timeout: 60_000 })
        .toContain(NUDGE);
      const input = await seat.stdinLog();
      expect(input.indexOf(`${first}\r`), `the first message reached ${node.id} whole`).toBeGreaterThanOrEqual(0);
      expect(input.indexOf(NUDGE), "the nudge comes after the first message").toBeGreaterThan(input.indexOf(`${first}\r`));
      await expectOnScreen(page, NUDGE, "the onboarding nudge");
      await shot(page, testInfo, `A2-nudge-in-${node.id}`);
      await closeSeatTerminal(page, surface);
    }

    // Learner runs `junto onboard`: its card turns to onboarded.
    if (CLI_BUILT) {
      const onboard = await seats.learner.cli(["onboard"]);
      expect(onboard.ok, cliText(onboard)).toBe(true);
    } else {
      note(testInfo, "A2-onboard-via", "dist/junto is missing: ran the `onboard` work-control op from the seat instead of the CLI");
      opData(await seats.learner.op("onboard", {}));
    }
    await expect(mark("learner"), "learner card after junto onboard").toHaveText("Onboarded", { timeout: 15_000 });
    await expect(mark("learner")).toHaveAttribute("data-onboarding", "onboarded");
    await expect(mark("stray"), "stray card, never onboarded").toHaveText("Not onboarded");
    await shot(page, testInfo, "A2-cards-onboarded-and-not");

    // Seven more turns on both seats. The policy would send a second nudge
    // into the third turn after the first (term/intervention/policy.ts
    // NUDGE_AFTER_TURNS), then none.
    const nudges = async (seat: CrewSeat): Promise<number> => occurrences(await seat.stdinLog(), NUDGE);
    for (let turn = 0; turn < 7; turn += 1) {
      for (const node of [learner, stray]) {
        await seats[node.id as "learner" | "stray"].control({ screen: { mode: "idle" } });
        await expectSeatState(page, node.id, "idle");
      }
      for (const node of [learner, stray]) {
        await seats[node.id as "learner" | "stray"].control({ screen: { mode: "working" } });
        await expectSeatState(page, node.id, "working");
      }
      // Let a nudge that is due land whole before the screen is changed again.
      await page.waitForTimeout(3_000);
    }

    const learnerNudges = await nudges(seats.learner);
    const strayNudges = await nudges(seats.stray);
    note(testInfo, "A2-nudge-counts", `learner (onboarded after the first): ${String(learnerNudges)}; stray (never onboarded): ${String(strayNudges)}`);
    expect(learnerNudges, "the nudge stops once the seat ran junto onboard").toBe(1);
    expect(strayNudges, "a seat that never onboards is nudged at most twice").toBeLessThanOrEqual(2);
    expect(strayNudges).toBeGreaterThanOrEqual(1);
    await expect(mark("stray")).toHaveText("Not onboarded");
    await shot(page, testInfo, "A2-after-seven-turns");
  });
});

test("A3 [fake-tui] mail to a seat that never onboarded carries the onboard pointer", async ({}, testInfo) => {
  test.setTimeout(300_000);
  await walk(testInfo, { seedCanvases: { [CANVAS]: pairDoc }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page } = junto;
    await crewPlayFactory(page);
    const ada = await startSeat(junto, ADA);
    const bo = await startSeat(junto, BO);
    const mark = seatCard(page, BO.id).getByTestId("agent-seat-onboarding");
    await expect(mark, "Bo has never onboarded").toHaveText("Not onboarded", { timeout: 30_000 });

    // Bo's terminal is open so the mail line can be read off its screen.
    await openSeatTerminal(page, BO.id);

    const firstText = "walk mail one: checksum 41";
    const sent = opData(await ada.op("msg.send", { target: BO.id, text: firstText }));
    expect(sent.delivery, JSON.stringify(sent)).toBe("delivered");
    await expect
      .poll(() => bo.stdinLog(), { message: "Bo's PTY input after the mail", timeout: 60_000 })
      .toContain(firstText);

    // The mail line itself carries the pointer: one paste, one line.
    const input = await bo.stdinLog();
    const line = input.slice(input.indexOf("mail from"));
    expect(line, "the mail line typed into a seat that never onboarded").toContain(MAIL_ONBOARD_POINTER);
    expect(line).toContain(firstText);
    await expectOnScreen(page, MAIL_ONBOARD_POINTER, "the onboard pointer on the mail line");
    await shot(page, testInfo, "A3-mail-line-with-pointer");

    // The contrast that gives the pointer its meaning: once Bo has
    // onboarded, the next mail line comes without it.
    opData(await bo.op("onboard", {}));
    await expect(mark).toHaveText("Onboarded", { timeout: 15_000 });
    const secondText = "walk mail two: checksum 42";
    const again = opData(await ada.op("msg.send", { target: BO.id, text: secondText }));
    await expect
      .poll(() => bo.stdinLog(), { message: "Bo's PTY input after the second mail", timeout: 60_000 })
      .toContain(secondText);
    await expect
      .poll(async () => (await crewReceipts(page, CANVAS, BO.id)).find((row) => row.messageId === again.messageId)?.deliveredAt, {
        timeout: 60_000,
      })
      .toBeDefined();
    expect(occurrences(await bo.stdinLog(), MAIL_ONBOARD_POINTER), "the pointer rides only mail to a seat that has not onboarded").toBe(1);
    await shot(page, testInfo, "A3-second-mail-without-pointer");
  });
});

test("A4 [fake-tui] mail waits for an operator draft, says so in amber, and delivers when the draft is gone", async ({}, testInfo) => {
  test.setTimeout(300_000);
  await walk(testInfo, { seedCanvases: { [CANVAS]: pairDoc }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page } = junto;
    await crewPlayFactory(page);
    const ada = await startSeat(junto, ADA);
    const bo = await startSeat(junto, BO);

    // The operator starts a draft in Bo and does not send it.
    const draft = "half a thought";
    const surface = await openSeatTerminal(page, BO.id);
    await focusSeatTerminal(page, surface);
    await page.keyboard.type(draft);
    await expect.poll(() => bo.stdinLog(), { message: "Bo's PTY input while drafting", timeout: 15_000 }).toContain(draft);
    await expectOnScreen(page, draft, "the operator's draft in the composer");
    await page.waitForTimeout(600);

    // Ada mails Bo while the draft is there.
    const mailText = "walk mail: do not type over me";
    const sent = opData(await ada.op("msg.send", { target: BO.id, text: mailText }));
    const messageId = String(sent.messageId);
    note(testInfo, "A4-delivery-while-drafting", `msg.send answered delivery=${JSON.stringify(sent.delivery)}`);
    expect(sent.delivery, "mail sent into a draft is not delivered yet").not.toBe("delivered");

    // The seat says so, in amber, naming the sender.
    const held = page.locator(`[data-testid="node-preamble"][data-node-id="${BO.id}"]`).filter({ hasText: "waits for your draft" }).first();
    await expect(held, "the amber line on the seat").toContainText(/mail from Ada waits for your draft/u, { timeout: 10_000 });
    await expect(held).toHaveAttribute("data-tone", "amber");
    await expect(held).toHaveAttribute("data-action", "mail-held");
    await shot(page, testInfo, "A4-mail-waits-for-draft");

    // Nothing was typed over the draft: no mail line and no paste reached
    // the seat's input, and its screen still shows the draft with no mail.
    await page.waitForTimeout(2_000);
    const whileWaiting = await bo.stdinLog();
    expect(whileWaiting, "Bo's PTY input while the mail waits").not.toContain("mail from");
    expect(whileWaiting, "Bo's PTY input while the mail waits").not.toContain("\u001b[200~");
    expect(whileWaiting.endsWith(draft), `the draft is still the last thing typed: ${JSON.stringify(whileWaiting)}`).toBe(true);
    await expectOnScreen(page, draft, "the draft, untouched", 5_000);
    expect(squash(await screenText(page)), "Bo's screen while the mail waits").not.toContain(squash(mailText));
    const waiting = (await crewReceipts(page, CANVAS, BO.id)).find((row) => row.messageId === messageId);
    expect(waiting?.deliveredAt, "no delivery receipt while the draft is there").toBeUndefined();

    // The draft goes: the operator sends it. (The fake composer has no
    // backspace, so sending is the key press that empties it.)
    await page.keyboard.press("Enter");
    await expect
      .poll(() => bo.stdinLog(), { message: "Bo's PTY input once the draft is gone", timeout: 60_000 })
      .toContain(mailText);
    const input = await bo.stdinLog();
    expect(input.includes(`${draft}\r`), `the draft went in whole, then the mail: ${JSON.stringify(input)}`).toBe(true);
    expect(input.indexOf("mail from")).toBeGreaterThan(input.indexOf(`${draft}\r`));
    await expect
      .poll(async () => (await crewReceipts(page, CANVAS, BO.id)).find((row) => row.messageId === messageId)?.deliveredAt, {
        message: "delivery receipt once the draft is gone",
        timeout: 60_000,
      })
      .toBeDefined();
    await expectOnScreen(page, mailText, "the mail line, after the draft was sent");
    await shot(page, testInfo, "A4-mail-delivered-after-draft");
  });
});

test("A5 [fake-tui] Ctrl+S in a seat does not freeze its output", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const seatNode = crewSeatNode({ id: "painter", label: "Painter", x: 160, y: 200 });
  await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([seatNode]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page } = junto;
    await crewPlayFactory(page);
    const seat = await startSeat(junto, seatNode);
    const surface = await openSeatTerminal(page, seatNode.id);
    await focusSeatTerminal(page, surface);

    await seat.print("walk-line-before-ctrl-s");
    await expectOnScreen(page, "walk-line-before-ctrl-s", "output painted before Ctrl+S");

    // Ctrl+S is the harness's key: it reaches the seat as XOFF (0x13).
    await page.keyboard.press("Control+s");
    await expect.poll(() => seat.stdinLog(), { message: "the seat's PTY input after Ctrl+S", timeout: 15_000 }).toContain("\u0013");

    // The seat keeps painting: new output shows, twice, and keys still arrive.
    await seat.print("walk-line-after-ctrl-s-1");
    await expectOnScreen(page, "walk-line-after-ctrl-s-1", "output painted after Ctrl+S", 20_000);
    await page.keyboard.type("still-typing");
    await expect.poll(() => seat.stdinLog(), { message: "keys typed after Ctrl+S", timeout: 15_000 }).toContain("still-typing");
    await seat.print("walk-line-after-ctrl-s-2");
    await expectOnScreen(page, "walk-line-after-ctrl-s-2", "more output painted after Ctrl+S", 20_000);
    await shot(page, testInfo, "A5-painting-after-ctrl-s");
  });
});

// ===========================================================================
// B. Region environment
// ===========================================================================

const VAULT = { id: "vault", label: "Vault", x: 40, y: 40, width: 620, height: 380 } as const;
const FILE_VALUE = "walk-file-value";

/** A dotenv file under os.tmpdir() that sets WALK_FROM_FILE. */
const writeEnvFile = async (dir: string): Promise<string> => {
  const path = join(dir, "walk.env");
  await writeFile(path, `WALK_FROM_FILE=${FILE_VALUE}\n`, "utf8");
  return path;
};

test("B1 the Environment screen takes a plain value and an env file, and lists both names with their source", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const dir = await tempDir();
  try {
    const envFile = await writeEnvFile(dir);
    await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([regionNode(VAULT)]) } }, async (junto) => {
      const { page } = junto;
      const dialog = await openRegionEnvironment(page, VAULT.id);
      await shot(page, testInfo, "B1-empty-screen");

      await addSource(dialog, "value", { name: "FOO", value: "bar" });
      await addSource(dialog, "envFile", { path: envFile });

      // Both sources are listed, each as what it is.
      const rows = dialog.getByTestId("region-env-source");
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("FOO");
      await expect(rows.nth(0)).toContainText("Plain value: bar");
      await expect(rows.nth(1)).toContainText(envFile);
      await expect(rows.nth(1)).toContainText("Env file");

      // The resolved list: both names, each with its source.
      await expect(variable(dialog, "FOO").locator(".region-env__origin")).toHaveText("Plain value, this region", { timeout: 30_000 });
      await expect(variable(dialog, "WALK_FROM_FILE").locator(".region-env__origin")).toHaveText("Env file, this region", { timeout: 30_000 });
      await expect(dialog.getByTestId("region-env-variable")).toHaveCount(2);
      // Names and sources only: the file's value is never shown.
      await expect(dialog.getByTestId("region-env")).not.toContainText(FILE_VALUE);
      await shot(page, testInfo, "B1-resolved-list");

      // Saved at once: the canvas carries both sources.
      await expect
        .poll(
          async () => {
            const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
            const region = doc.nodes.find((node) => node.id === VAULT.id);
            const sources = region?.type === "group" ? (region.ether?.region?.environment?.sources ?? []) : [];
            return sources.map((source) => source.kind);
          },
          { message: "the region's saved sources", timeout: 15_000 },
        )
        .toEqual(["value", "envFile"]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("B2 [fake-tui] a seat inside the region gets FOO and reports its source; a seat outside has neither", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const dir = await tempDir();
  try {
    const envFile = await writeEnvFile(dir);
    const vault = regionNode({
      ...VAULT,
      sources: [plainValue("src-foo", "FOO", "bar"), { id: "src-file", kind: "envFile", path: envFile }],
    });
    const inside = crewSeatNode({ id: "inside", label: "Inside", x: 100, y: 200 });
    const outside = crewSeatNode({ id: "outside", label: "Outside", x: 760, y: 200 });

    await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([vault, inside, outside]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
      const { page, sandbox } = junto;
      await crewPlayFactory(page);
      const insideSeat = await startSeat(junto, inside);
      const outsideSeat = await startSeat(junto, outside);
      await shot(page, testInfo, "B2-seats-started");

      // `echo "$FOO"` in each seat: what its process was started with. A
      // fake seat is not a shell, so this is the wrapper's launch record.
      expect(await seatLaunches(sandbox, inside.id), "the seat inside the region").toEqual([
        { FOO: "bar", WALK_FROM_FILE: FILE_VALUE, WALK_OUTER_ONLY: UNSET },
      ]);
      expect(await seatLaunches(sandbox, outside.id), "the seat outside the region").toEqual([
        { FOO: UNSET, WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: UNSET },
      ]);

      // `junto env report` from each seat.
      const report = async (seat: CrewSeat): Promise<{ readonly rows: ReadonlyArray<SourceRow>; readonly text: string }> => {
        if (CLI_BUILT) {
          const result = await seat.cli(["env", "report"]);
          expect(result.ok, cliText(result)).toBe(true);
          return { rows: sourceRows(cliJson(result)), text: cliText(result) };
        }
        const data = opData(await seat.op("env.report", {}));
        return { rows: sourceRows(data), text: JSON.stringify(data) };
      };
      if (!CLI_BUILT) {
        note(testInfo, "B2-env-report-via", "dist/junto is missing: read the `env.report` work-control op from the seat instead of the CLI");
      }

      const insideReport = await report(insideSeat);
      expect(
        insideReport.rows.map((row) => ({ regionId: row.regionId, kind: row.kind, names: row.names, status: row.status })),
        `junto env report inside the region: ${insideReport.text}`,
      ).toEqual([
        { regionId: VAULT.id, kind: "value", names: ["FOO"], status: "ok" },
        { regionId: VAULT.id, kind: "envFile", names: ["WALK_FROM_FILE"], status: "ok" },
      ]);
      // The checklist says the report shows the value. The command is written
      // to show names and sources and never a value (src/cli/commands/env.ts).
      // Recorded, not asserted: which of the two the operator wants is theirs.
      note(testInfo, "B2-env-report-shows-value", String(insideReport.text.includes(FILE_VALUE)));

      const outsideReport = await report(outsideSeat);
      expect(outsideReport.rows, `junto env report outside the region: ${outsideReport.text}`).toEqual([]);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("B3 [fake-tui] a required Keychain source that does not exist shows red with a reason, refuses the seat, and fails env doctor", async ({}, testInfo) => {
  test.setTimeout(300_000);
  // Made up, and looked up only: nothing is created under this name.
  const service = `junto-e2e-no-such-service-${Math.random().toString(36).slice(2, 10)}`;
  const boss = crewSeatNode({ id: "boss", label: "Boss", x: 760, y: 200 });
  const kept = crewSeatNode({ id: "kept", label: "Kept", x: 100, y: 200 });

  await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([regionNode(VAULT), kept, boss]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page, sandbox } = junto;
    await crewPlayFactory(page);

    // The overseer sits outside the region, so it can start. The grant goes
    // through the human seam (overseer-seat.spec.ts), before any edit here.
    const bossSeat = await startSeat(junto, boss);
    await page.evaluate(
      async ([canvasName, nodeId]) => {
        const api = window.junto!;
        for (let attempt = 0; ; attempt += 1) {
          const read = await api.readCanvas(canvasName);
          try {
            await api.canvasOverseerSet({ canvasName, nodeId, overseer: true, expectedRevision: read.revision });
            return;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
      },
      [CANVAS, boss.id] as const,
    );
    await expect(seatCard(page, boss.id).locator(".junto-node")).toHaveAttribute("data-overseer", "true", { timeout: 15_000 });

    // The screen: the source is red, with a reason, and says seats will not start.
    const dialog = await openRegionEnvironment(page, VAULT.id);
    await addSource(dialog, "keychain", { name: "WALK_KEYCHAIN_SECRET", service }, { required: true });
    const row = dialog.getByTestId("region-env-source");
    await expect(row).toHaveCount(1);
    const rowReason = row.locator(".region-env__error");
    await expect(rowReason, "the failing source's reason, in the error colour").toBeVisible({ timeout: 30_000 });
    const reason = ((await rowReason.textContent()) ?? "").trim();
    note(testInfo, "B3-reason-on-screen", reason);
    expect(reason, "the reason is words, not empty").not.toBe("");
    await expect(row, "the source's status chip").toContainText(/Missing|Error/u);
    await expect(row).toContainText("required");
    await expect(dialog.getByTestId("region-env-blocks-launch")).toHaveText(
      "A required source is failing, so seats in this region will not start until it is fixed.",
    );
    await expect(variable(dialog, "WALK_KEYCHAIN_SECRET")).toContainText("not set");
    await expect(variable(dialog, "WALK_KEYCHAIN_SECRET")).toContainText(reason);
    await shot(page, testInfo, "B3-screen-red-with-reason");
    await closeRegionEnvironment(dialog);

    // The seat refuses to start, with that reason: main's own answer first.
    const refusal = await page.evaluate(
      async ([canvasName, node]) => {
        try {
          await window.junto!.terminalCreate({ node, canvasName });
          return "the seat started";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      [CANVAS, kept] as const,
    );
    expect(refusal, "starting a seat in the region").toContain("This seat was not started.");
    expect(refusal, "the refusal gives the screen's reason").toContain(reason);
    expect(existsSync(join(crewSeat(sandbox, CANVAS, kept.id).dir, "ready.json")), "no seat process was started").toBe(false);

    // And as the operator meets it: opening the seat shows the same words.
    await seatCard(page, kept.id).dblclick();
    const surface = page.locator(SURFACE);
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface, "the seat's terminal says why it did not start").toContainText(reason, { timeout: 30_000 });
    await shot(page, testInfo, "B3-seat-refused");
    expect(existsSync(join(crewSeat(sandbox, CANVAS, kept.id).dir, "ready.json")), "still no seat process").toBe(false);
    expect(await seatLaunches(sandbox, kept.id), "the seat was never launched").toEqual([]);

    // `junto overseer env doctor`, run by the overseer seat: non-zero, same reason.
    if (!CLI_BUILT) throw new Error(CLI_MISSING);
    const doctor = await bossSeat.cli(["overseer", "env", "doctor"]);
    const doctorRows = sourceRows(cliJson(doctor));
    const failing = doctorRows.filter((entry) => entry.names.includes("WALK_KEYCHAIN_SECRET"));
    expect(failing.length, `junto overseer env doctor printed: ${cliText(doctor)}`).toBeGreaterThan(0);
    for (const entry of failing) {
      expect(entry.required, cliText(doctor)).toBe(true);
      expect(entry.status, cliText(doctor)).toMatch(/^(missing|error)$/u);
      expect(entry.reason, "env doctor prints the screen's reason").toBe(reason);
    }
    expect(doctor.exitCode, `junto overseer env doctor exit code. Output: ${cliText(doctor)}`).not.toBe(0);
  });
});

test("B4 [fake-tui] an inner region overrides FOO, and sealing it drops the outer names", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const outer = regionNode({
    ...VAULT,
    sources: [plainValue("src-foo", "FOO", "outer-value"), plainValue("src-outer", "WALK_OUTER_ONLY", "outer-only")],
  });
  const inner = regionNode({
    id: "inner",
    label: "Inner",
    x: 80,
    y: 140,
    width: 400,
    height: 240,
    sources: [plainValue("src-foo-inner", "FOO", "inner-value")],
  });
  const deep = crewSeatNode({ id: "deep", label: "Deep", x: 120, y: 230 });

  await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([outer, inner, deep]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page, sandbox } = junto;
    await crewPlayFactory(page);
    await startSeat(junto, deep);

    // The seat in the inner region gets the inner FOO, and the outer names.
    expect(await seatLaunches(sandbox, deep.id), "the seat in the inner region, before sealing").toEqual([
      { FOO: "inner-value", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: "outer-only" },
    ]);

    // The inner region's screen says the same: FOO is its own and overrides
    // the outer one; the outer-only name is inherited.
    const dialog = await openRegionEnvironment(page, inner.id);
    await expect(variable(dialog, "FOO").locator(".region-env__origin")).toHaveText("Plain value, this region", { timeout: 30_000 });
    await expect(variable(dialog, "FOO").locator(".region-env__overridden")).toContainText("inherited from");
    await expect(variable(dialog, "FOO").locator(".region-env__overridden")).toContainText("overridden");
    await expect(variable(dialog, "WALK_OUTER_ONLY").locator(".region-env__origin")).toHaveAttribute("data-inherited", "true");
    await shot(page, testInfo, "B4-inner-overrides-outer");

    // Seal the inner region: the outer names leave its resolved list.
    const sealed = dialog.getByTestId("region-env-sealed");
    await sealed.click();
    await expect(sealed).toBeChecked();
    await expect(variable(dialog, "WALK_OUTER_ONLY"), "the outer-only name, once the inner region is sealed").toHaveCount(0, { timeout: 30_000 });
    await expect(variable(dialog, "FOO").locator(".region-env__origin")).toHaveText("Plain value, this region");
    await expect(variable(dialog, "FOO").locator(".region-env__overridden")).toHaveCount(0);
    await expect(dialog.getByTestId("region-env-variable")).toHaveCount(1);

    // The running seat still has what it started with; restart it from the screen.
    const stale = dialog.getByTestId("region-env-stale");
    await expect(stale, "the running seat is listed for a restart").toContainText("Changes on restart: WALK_OUTER_ONLY", { timeout: 30_000 });
    await shot(page, testInfo, "B4-sealed-restart-to-apply");
    await stale.getByTestId("region-env-restart").click();
    await expect
      .poll(() => seatLaunches(sandbox, deep.id), { message: "the seat in the sealed inner region, after its restart", timeout: 90_000 })
      .toEqual([
        { FOO: "inner-value", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: "outer-only" },
        { FOO: "inner-value", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: UNSET },
      ]);
    await expect(stale).toHaveCount(0, { timeout: 30_000 });
    await shot(page, testInfo, "B4-sealed-seat-restarted");
  });
});

test("B5 [fake-tui] editing a source while a seat runs offers Restart to apply, and the restart keeps the session with the new value", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const SESSION = "sess-walk-0001";
  const vault = regionNode({ ...VAULT, sources: [plainValue("src-foo", "FOO", "bar")] });
  const base = crewSeatNode({ id: "runner", label: "Runner", x: 100, y: 200 });
  // A seat with a session to keep, seeded the way seat-sessions.spec.ts does.
  const runner: TextNode = {
    ...base,
    ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: SESSION } },
  };

  await walk(testInfo, { seedCanvases: { [CANVAS]: crewDoc([vault, runner]) }, afterSeed: installWalkSeatHarness }, async (junto) => {
    const { page, sandbox } = junto;
    await crewPlayFactory(page);
    const seat = await startSeat(junto, runner);
    const started = await seat.ready();
    expect(await seatLaunches(sandbox, runner.id), "the seat's first launch").toEqual([
      { FOO: "bar", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: UNSET },
    ]);
    const sessionNow = async (): Promise<unknown> =>
      (opData(await seat.op("onboard", {})).sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)?.current
        ?.session_id;
    expect(await sessionNow(), "the session the seat starts on").toBe(SESSION);
    expect(opData(await seat.op("env.report", {})).restartToApply, "nothing to apply before the edit").toBe(false);

    // Edit the source while the seat is running.
    const dialog = await openRegionEnvironment(page, VAULT.id);
    await expect(dialog.getByTestId("region-env-stale"), "no restart is offered before the edit").toHaveCount(0);
    await dialog.getByRole("button", { name: "Edit FOO" }).click();
    const form = dialog.getByTestId("region-env-form");
    await expect(form.getByTestId("region-env-field-value")).toHaveValue("bar");
    await form.getByTestId("region-env-field-value").fill("baz");
    await form.getByTestId("region-env-save-source").click();
    await expect(form).toHaveCount(0);
    await expect(dialog.getByTestId("region-env-source")).toContainText("Plain value: baz");

    // The seat shows "Restart to apply": on the screen, and in its own report.
    const stale = dialog.getByTestId("region-env-stale");
    await expect(stale.getByRole("heading", { name: "Restart to apply" })).toBeVisible({ timeout: 30_000 });
    await expect(stale, "the running seat, listed with what changes").toContainText("Changes on restart: FOO");
    await expect.poll(async () => opData(await seat.op("env.report", {})).restartToApply, { timeout: 15_000 }).toBe(true);
    // The running process still has the old value.
    expect(await seatLaunches(sandbox, runner.id)).toHaveLength(1);
    await shot(page, testInfo, "B5-restart-to-apply");

    // The button restarts it: a new process, the same session, the new value.
    await stale.getByTestId("region-env-restart").click();
    await expect
      .poll(() => seatLaunches(sandbox, runner.id), { message: "the seat's launches after the restart", timeout: 90_000 })
      .toEqual([
        { FOO: "bar", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: UNSET },
        { FOO: "baz", WALK_FROM_FILE: UNSET, WALK_OUTER_ONLY: UNSET },
      ]);
    await expect.poll(async () => (await seat.ready()).pid, { message: "a new seat process", timeout: 30_000 }).not.toBe(started.pid);
    await expect(stale, "nothing left to restart").toHaveCount(0, { timeout: 30_000 });
    await expectSeatState(page, runner.id, /^(idle|working)$/u);

    await expect.poll(sessionNow, { message: "the session after the restart", timeout: 30_000 }).toBe(SESSION);
    const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
    expect(doc.nodes.find((node) => node.id === runner.id)?.ether?.terminal?.sessionId, "the seat's stored session id").toBe(SESSION);
    note(testInfo, "B5-restart-argv", JSON.stringify((await seat.ready()).argv));
    await expect.poll(async () => opData(await seat.op("env.report", {})).restartToApply, { timeout: 15_000 }).toBe(false);
    await shot(page, testInfo, "B5-restarted-on-new-value");
  });
});
