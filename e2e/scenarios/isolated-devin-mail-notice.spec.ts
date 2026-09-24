/**
 * Isolated real-Devin mail observation [real-harness]. A real Devin seat
 * settles at an empty prompt, then receives fresh mail, then a second notice
 * on the same warm generation, sent at once whatever the seat is doing. Each
 * msg.send must answer delivered, the app projection must carry the
 * deliveredAt receipt and then a readAt receipt, and the trace must show
 * exactly one mail paste per message on the Devin binding.
 *
 * ISOLATED_DEVIN_HOLD=1 exposes the live app for Computer Use after observation
 * (also on failure). Final evidence is collected after the bounded hold and
 * before teardown. The latest run and its PIDs are in /tmp/isolated-devin-mail-hold.json.
 * This probe never qualifies typed notices or opens the running app database.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { promptBoxBody } from "../../src/main/junto/term/observer/regions";
import type { Message } from "../../src/shared/work-model";
import { composeMessageDeliveryPayload } from "../../src/shared/message-delivery";
import { SeatReadResult } from "../../src/shared/seat-control";
import { transportLogDirectory } from "../../src/shared/transport-trace";
import { expect, launchJunto, test } from "../harness/launch";
import { crewPlayFactory, crewSeat, type CrewSeat } from "../harness/crew-fixture";
import { HARNESS_MAIL_TRANSPORT } from "../../src/shared/managed-terminal-templates";
import {
  ISOLATED_DEVIN_CREDENTIAL_REL,
  ISOLATED_DEVIN_MAIL_CANVAS,
  ISOLATED_DEVIN_RECEIVER_ID,
  ISOLATED_DEVIN_SENDER_ID,
  isolatedDevinMailDoc,
  isolatedDevinReceiverNode,
  isolatedDevinSenderNode,
  resolveOperatorDevinBinary,
  seedIsolatedDevinAppHome,
} from "../harness/isolated-devin-mail-fixture";

const operatorHome = homedir();
const operatorCred = join(operatorHome, ISOLATED_DEVIN_CREDENTIAL_REL);
const HOLD = process.env.ISOLATED_DEVIN_HOLD === "1";
const HOLD_MS = Number.parseInt(process.env.ISOLATED_DEVIN_HOLD_MS ?? "90000", 10);
const READY_MS = 120_000;
const OBSERVE_MS = 90_000;
const DEVIN_BINDING = "local:isolated-devin";
const HOLD_NOTE = join("/tmp", "isolated-devin-mail-hold.json");

const sha256File = (path: string): string | undefined => {
  if (!existsSync(path)) return undefined;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
};

const embeddedBuildIdentity = () => {
  const mainPath = join(process.cwd(), "out", "main", "index.js");
  if (!existsSync(mainPath)) return undefined;
  const markers = [...readFileSync(mainPath, "utf8").matchAll(/\/\* JUNTO_RUNTIME_BUILD_IDENTITY:([A-Za-z0-9_-]*) \*\//gu)];
  const payload = markers[0]?.[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof identity !== "object" || identity === null) return undefined;
    const record = identity as { cohortNonce?: unknown; sourceCommit?: unknown; runtime?: unknown };
    return {
      cohortNonce: typeof record.cohortNonce === "string" ? record.cohortNonce : undefined,
      sourceCommit: typeof record.sourceCommit === "string" ? record.sourceCommit : undefined,
      runtime: typeof record.runtime === "string" ? record.runtime : undefined,
    };
  } catch {
    return undefined;
  }
};

const runtimeProvenance = () => {
  const rendererDir = join(process.cwd(), "out", "renderer", "assets");
  const rendererAssets = existsSync(rendererDir)
    ? readdirSync(rendererDir).filter((name) => /\.(js|css)$/.test(name)).sort()
    : [];
  let checkoutCommit = "unknown";
  try {
    checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* ignore */
  }
  let checkoutDiffSha256 = "clean";
  try {
    const diff = execFileSync("git", ["diff", "HEAD"], { encoding: "buffer" });
    if (diff.length > 0) {
      checkoutDiffSha256 = createHash("sha256").update(diff).digest("hex");
    }
  } catch {
    checkoutDiffSha256 = "unknown";
  }
  return {
    builtSourceCorrespondence: "unverified-by-spec",
    checkoutCommit,
    checkoutDiffSha256,
    embeddedBuildIdentity: embeddedBuildIdentity() ?? null,
    outMainSha256: sha256File(join(process.cwd(), "out", "main", "index.js")),
    outPreloadSha256: sha256File(join(process.cwd(), "out", "preload", "index.cjs")),
    outRendererIndexSha256: sha256File(join(process.cwd(), "out", "renderer", "index.html")),
    outRendererAssets: rendererAssets.map((name) => ({ name, sha256: sha256File(join(rendererDir, name)) })),
  };
};

const projectedMessages = async (page: Page): Promise<ReadonlyArray<Message>> => {
  const read = await page.evaluate(async (name) => window.junto!.readCanvas(name), ISOLATED_DEVIN_MAIL_CANVAS);
  const node = read.doc.nodes.find((entry) => entry.id === ISOLATED_DEVIN_RECEIVER_ID);
  if (node === undefined) throw new Error("The isolated Devin mailbox sink is missing from readCanvas");
  return node.ether?.messages?.items ?? [];
};

const readDevin = async (sender: CrewSeat): Promise<SeatReadResult> => {
  const result = await sender.op("seat.read", { target: ISOLATED_DEVIN_RECEIVER_ID, lines: 120 });
  if (!result.ok) throw new Error(`seat.read failed: ${JSON.stringify(result.error)}`);
  return Schema.decodeUnknownSync(SeatReadResult)(result.data);
};

const selectedTrustPrompt = (grid: SeatReadResult): boolean => {
  if (grid.replaced || grid.epoch !== grid.generation || grid.state !== "attention" ||
      grid.confidence !== "high" || grid.reason !== "rule:workspace_trust_prompt") return false;
  const tail = grid.text.split("\n").filter((line) => line.trim().length > 0).slice(-16).join("\n");
  return /do you trust the authors of this directory\?/i.test(tail) &&
    /^\s*❭\s*1\s+Yes, trust\b/im.test(tail) &&
    /^\s*(?:\u00b7\s*)?2\s+No, exit\b/im.test(tail) && /to choose/i.test(tail);
};

const eligiblePrompt = (grid: SeatReadResult): boolean => {
  if (grid.replaced || grid.generation.length === 0 || grid.epoch !== grid.generation ||
      grid.state !== "idle" || grid.confidence !== "high" ||
      !["rule:welcome_prompt_footer", "rule:live_prompt_footer"].includes(grid.reason)) return false;
  const lines = grid.text.split("\n");
  const tail = lines.filter((line) => line.trim().length > 0).slice(-8);
  const text = tail.join("\n");
  if (/do you trust|approve once|esc cancel|running tools|esc to interrupt|guide devin while it works/i.test(text)) return false;
  const composer = promptBoxBody(lines).join("\n");
  return (
    /^\s*❭ Ask Devin to build features, fix bugs, or work on your code\s*$/.test(composer) ||
    (/^\s*❭\s*$/.test(composer) && /context:/i.test(text))
  );
};

const occupyDevinOnce = async (page: Page) => {
  await page.evaluate(async ([canvas, node]) => {
    await window.junto!.terminalCreate({ node, canvasName: canvas });
  }, [ISOLATED_DEVIN_MAIL_CANVAS, isolatedDevinReceiverNode] as const);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const session = await page.evaluate(async (bindingId) => window.junto!.terminalGet(bindingId), DEVIN_BINDING);
    if (session?.status === "running" && session.pid !== undefined && session.pid > 0) return session;
    await page.waitForTimeout(250);
  }
  throw new Error("Real Devin never ran after one terminalCreate");
};

const receiptAt = (value: unknown, key: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid projected ${key} receipt`);
  return value;
};

/** The message's receipts: typed into the seat (deliveredAt), then read (readAt). */
const outcomeOf = (message: Message | undefined) => {
  const deliveredAt = receiptAt(message?.metadata?.deliveredAt, "deliveredAt");
  const readAt = receiptAt(message?.metadata?.readAt, "readAt");
  if (readAt !== undefined) return { kind: "read" as const, deliveredAt, readAt };
  if (deliveredAt !== undefined) return { kind: "delivered" as const, deliveredAt };
  return { kind: message === undefined ? "missing-message" as const : "waiting" as const };
};

/**
 * Successful paste writes inside the drive's mail writes on the Devin
 * binding. The trace carries no message id for mail, so this counts every
 * mail paste on the binding; the probe sends nothing else through it.
 */
const mailPastes = (homeDir: string): number => {
  const logs = transportLogDirectory(homeDir);
  if (existsSync(join(logs, "pty-delivery.jsonl.1"))) {
    throw new Error("PTY trace rotated; the complete mail write history is unavailable");
  }
  let inMail = false;
  let pastes = 0;
  for (const line of readFileSync(join(logs, "pty-delivery.jsonl"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const row = JSON.parse(line) as { bindingId?: unknown; event?: unknown; fields?: { stage?: unknown; ok?: unknown } };
    if (row.bindingId !== DEVIN_BINDING) continue;
    if (row.event === "mail.begin") inMail = true;
    else if (row.event === "mail.end") inMail = false;
    else if (inMail && row.event === "write.end" && row.fields?.stage === "paste" && row.fields.ok === true) pastes += 1;
  }
  return pastes;
};

const observed = async <T>(body: () => Promise<T>) => {
  try { return { ok: true as const, value: await body() }; }
  catch (error) { return { ok: false as const, error: String(error) }; }
};

test("isolated Devin [real-harness]: delivered mail reaches readAt", async () => {
  if (!Number.isFinite(HOLD_MS) || HOLD_MS < 0 || HOLD_MS > 600_000) throw new Error("ISOLATED_DEVIN_HOLD_MS must be between 0 and 600000");
  test.setTimeout((HOLD ? HOLD_MS : 0) + 630_000);
  if (!existsSync(operatorCred)) test.skip(true, "no operator Devin credentials.toml to seed");
  if (resolveOperatorDevinBinary(process.env.PATH ?? "") === undefined) test.skip(true, "real devin binary not on PATH");
  const qualificationAtStart = HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified;
  if (HOLD) process.env.JUNTO_E2E_SHOW = "1";

  const provenance = runtimeProvenance();
  const artifacts = mkdtempSync(join("/tmp", "isolated-devin-mail-evidence-"));
  const artifact = (name: string) => join(artifacts, name);
  const json = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  json(HOLD_NOTE, { phase: "prelaunch", at: new Date().toISOString(), artifacts, ...provenance });
  const junto = await launchJunto({
    seedCanvases: { [ISOLATED_DEVIN_MAIL_CANVAS]: isolatedDevinMailDoc() },
    extraEnv: { JUNTO_PTY_TRACE: "1" },
    afterSeed: async (sandbox) => {
      const prepared = await seedIsolatedDevinAppHome(sandbox, operatorHome, process.env.PATH ?? "");
      if (!prepared.ok) throw new Error(prepared.limitation);
      expect(prepared.seeded.copied).toContain(ISOLATED_DEVIN_CREDENTIAL_REL);
      expect(existsSync(join(sandbox.homeDir, ".local/share/devin/cli/sessions.db"))).toBe(false);
    },
  });
  const { page, sandbox } = junto;
  const sender = crewSeat(sandbox, ISOLATED_DEVIN_MAIL_CANVAS, ISOLATED_DEVIN_SENDER_ID);
  let occupied: Awaited<ReturnType<typeof occupyDevinOnce>> | undefined;
  let messageId: string | undefined;
  let messageId2: string | undefined;
  let outcome2: ReturnType<typeof outcomeOf> | undefined;
  let secondNoticeSkipped: string | undefined;
  let ready: SeatReadResult | undefined;
  let failure: unknown;
  let trustConfirmed = false;

  const writeHold = (extra: Record<string, unknown>) => {
    const body = {
      ...provenance, at: new Date().toISOString(), artifacts,
      electronMainPid: junto.app.process().pid, harnessPid: occupied?.pid,
      cohortNonce: provenance.embeddedBuildIdentity?.cohortNonce ?? null,
      bindingId: occupied?.bindingId, epoch: occupied?.epoch, cwd: occupied?.cwd,
      sandboxHome: sandbox.homeDir, canvas: ISOLATED_DEVIN_MAIL_CANVAS, messageId, messageId2,
      window: HOLD ? "visible" : "offscreen", holdMs: HOLD ? HOLD_MS : 0,
      typedNoticeQualified: qualificationAtStart, ...extra,
    };
    json(HOLD_NOTE, body);
    return body;
  };

  const preserveLogs = () => {
    const logs = transportLogDirectory(sandbox.homeDir);
    return ["pty-delivery.jsonl", "pty-delivery.jsonl.1", "transport.jsonl", "transport.jsonl.1"].map((name) => {
      const source = join(logs, name);
      if (!existsSync(source)) return { name, available: false as const };
      const path = artifact(name);
      copyFileSync(source, path);
      return { name, available: true as const, path, bytes: readFileSync(path).length, sha256: sha256File(path) };
    });
  };

  try {
    try {
      if (HOLD) await junto.app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) { win.show(); win.focus(); }
      });
      console.log(`ISOLATED_DEVIN_HOLD ${JSON.stringify(writeHold({ phase: "launched" }))}`);
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      await crewPlayFactory(page);
      await page.evaluate(async ([canvas, node]) => {
        await window.junto!.terminalCreate({ node, canvasName: canvas });
      }, [ISOLATED_DEVIN_MAIL_CANVAS, isolatedDevinSenderNode] as const);
      await sender.ready(45_000);
      occupied = await occupyDevinOnce(page);
      writeHold({ phase: "waiting-ready" });
      // This occupied-seat gesture activates its view; it must not create a
      // second process. Every observation below keeps the original epoch.
      await page.locator(`.react-flow__node[data-id="${ISOLATED_DEVIN_RECEIVER_ID}"]`).dblclick();
      const front = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
      await expect(front).toBeVisible({ timeout: 30_000 });
      const awaitReady = async (): Promise<SeatReadResult> => {
        const deadline = Date.now() + READY_MS;
        let stable = "";
        let stableSince = 0;
        while (Date.now() < deadline) {
          const grid = await readDevin(sender);
          json(artifact("readiness-latest.json"), grid);
          if (grid.replaced || grid.epoch !== occupied!.epoch) throw new Error("Devin generation changed during readiness");
          if (selectedTrustPrompt(grid)) {
            stable = "";
            if (!trustConfirmed) {
              await front.locator(".xterm-screen").click();
              await page.screenshot({ path: artifact("trust-before-enter.png"), fullPage: true });
              const current = await readDevin(sender);
              if (current.epoch === occupied!.epoch && selectedTrustPrompt(current)) {
                json(artifact("trust-before-enter.json"), current);
                await page.keyboard.press("Enter");
                trustConfirmed = true;
                writeHold({ phase: "trust-confirmed", trustEvidence: artifact("trust-before-enter.json") });
              }
            }
          } else if (eligiblePrompt(grid)) {
            const key = `${grid.epoch}:${grid.reason}:${grid.text}`;
            if (key !== stable) { stable = key; stableSince = Date.now(); }
            if (Date.now() - stableSince >= 2_500) return grid;
          } else { stable = ""; }
          await page.waitForTimeout(500);
        }
        throw new Error("Devin never reached a stable, high-confidence empty prompt; no mail was sent");
      };
      ready = await awaitReady();
      json(artifact("ready-before-send.json"), ready);
      const live = await page.evaluate(async (id) => window.junto!.terminalGet(id), DEVIN_BINDING);
      if (live?.pid !== occupied.pid || live?.epoch !== occupied.epoch) throw new Error("Opening Devin replaced its occupied process");

      const sendAndObserve = async (nonce: string, slot: 1 | 2) => {
        const send = await sender.op("msg.send", { target: ISOLATED_DEVIN_RECEIVER_ID, text: nonce });
        if (!send.ok) throw new Error(`msg.send failed: ${JSON.stringify(send.error)}`);
        const sent = send.data as { messageId?: string; delivery?: string } | undefined;
        const id = sent?.messageId;
        if (typeof id !== "string" || id.length === 0) throw new Error("msg.send did not return a messageId");
        // Record the durable id before polling so a timed-out observation
        // still preserves which message was actually sent.
        if (slot === 1) messageId = id; else messageId2 = id;
        if (sent?.delivery !== "delivered") throw new Error(`msg.send answered delivery=${String(sent?.delivery)} for a live seat`);
        writeHold({ phase: "observing-mail", delivery: sent.delivery, readyEvidence: artifact("ready-before-send.json") });
        const until = Date.now() + OBSERVE_MS;
        let outcome: ReturnType<typeof outcomeOf> = { kind: "waiting" };
        while (Date.now() < until) {
          outcome = outcomeOf((await projectedMessages(page)).find((item) => item.messageId === id));
          writeHold({ phase: "observing-mail", outcome });
          if (outcome.kind === "read") break;
          await page.waitForTimeout(500);
        }
        if (outcome.kind !== "read") {
          throw new Error(`No read receipt after ${OBSERVE_MS}ms: ${JSON.stringify(outcome)}`);
        }
        return { messageId: id, outcome };
      };
      const first = await sendAndObserve(`isolated-devin-mail ${Date.now()}`, 1);
      writeHold({ phase: "first-outcome", outcome: first.outcome });
      // A second notice on the same warm generation is part of qualification.
      // If the seat already moved or exited, record the precise reason instead
      // of forcing a send; the run then stays unqualified evidence. The seat
      // may still be working on the first mail: the notice is typed at once
      // and Devin queues or steers it.
      const warm = await page.evaluate(async (id) => window.junto!.terminalGet(id), DEVIN_BINDING);
      if (warm?.status !== "running" || warm.epoch !== occupied.epoch) {
        secondNoticeSkipped = `seat-not-warm status=${warm?.status ?? "gone"} epoch=${warm?.epoch ?? "none"}`;
      } else {
        try {
          const second = await sendAndObserve(`isolated-devin-mail-warm ${Date.now()}`, 2);
          outcome2 = second.outcome;
        } catch (error) {
          secondNoticeSkipped = String(error);
        }
      }
      writeHold({ phase: "observed-mail", outcome: first.outcome, outcome2, secondNoticeSkipped });
    } catch (error) {
      failure = error;
      writeHold({ phase: "observation-failed", error: String(error) });
    }

    if (HOLD) {
      try {
        console.log(`ISOLATED_DEVIN_HOLD ${JSON.stringify(writeHold({ phase: "holding", error: failure === undefined ? undefined : String(failure) }))}`);
        const until = Date.now() + HOLD_MS;
        while (Date.now() < until) {
          const mail = await observed(async () => (await projectedMessages(page)).find((item) => item.messageId === messageId));
          writeHold({ phase: "holding", mail, error: failure === undefined ? undefined : String(failure) });
          await page.waitForTimeout(Math.min(1_000, Math.max(0, until - Date.now())));
        }
      } catch (error) {
        failure ??= error;
      }
    }

    // END evidence: every source is read after observation/hold, while the
    // app still owns its database. Failed sources stay explicit, never empty.
    const [mail, mail2, grid, session, pasteCount, screenshot] = await Promise.all([
      observed(async () => (await projectedMessages(page)).find((item) => item.messageId === messageId)),
      observed(async () => {
        if (messageId2 === undefined) throw new Error(secondNoticeSkipped ?? "No second notice was sent");
        return (await projectedMessages(page)).find((item) => item.messageId === messageId2);
      }),
      observed(() => readDevin(sender)),
      observed(() => page.evaluate(async (id) => window.junto!.terminalGet(id), DEVIN_BINDING)),
      observed(async () => mailPastes(sandbox.homeDir)),
      observed(async () => {
        const path = artifact("seat-final.png");
        await page.screenshot({ path, fullPage: true });
        return path;
      }),
    ]);
    const logs = await observed(async () => preserveLogs());
    const outcome = await observed(async () => mail.ok ? outcomeOf(mail.value) : undefined);
    const finalOutcome = outcome.ok ? outcome.value : undefined;
    const finalOutcome2 = mail2.ok ? outcomeOf(mail2.value) : undefined;
    const payload = await observed(async () => mail.ok && mail.value !== undefined ? composeMessageDeliveryPayload(mail.value) : undefined);
    const payload2 = await observed(async () => mail2.ok && mail2.value !== undefined ? composeMessageDeliveryPayload(mail2.value) : undefined);
    const facts = {
      at: new Date().toISOString(), messageId, mail, outcome: finalOutcome, session,
      mailPastes: pasteCount.ok ? pasteCount.value : null, pasteEvidence: pasteCount,
      secondNotice: {
        messageId: messageId2, mail: mail2, outcome: finalOutcome2, skipped: secondNoticeSkipped,
        payloadSha256: payload2.ok && payload2.value !== undefined ? createHash("sha256").update(payload2.value).digest("hex") : undefined,
        payloadError: payload2.ok ? undefined : payload2.error,
      },
      correlation: { bindingId: DEVIN_BINDING, payloadSha256: payload.ok && payload.value !== undefined ? createHash("sha256").update(payload.value).digest("hex") : undefined, payloadError: payload.ok ? undefined : payload.error, scope: "one fresh message plus one warm-seat message, unchanged recipient generation" },
      typedNoticeQualified: qualificationAtStart,
    };
    json(artifact("seat-read-final.json"), grid);
    json(artifact("mail-facts-final.json"), facts);
    json(artifact("run-final.json"), writeHold({
      phase: "final-before-close", outcome, failure: failure === undefined ? undefined : String(failure),
      mailFacts: artifact("mail-facts-final.json"), seatRead: artifact("seat-read-final.json"), screenshot, logs,
    }));
    if (failure !== undefined) throw failure;
    expect(ready).toBeDefined();
    expect(mail.ok, JSON.stringify(mail)).toBe(true);
    expect(grid.ok, JSON.stringify(grid)).toBe(true);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(payload.ok, JSON.stringify(payload)).toBe(true);
    expect(screenshot.ok, JSON.stringify(screenshot)).toBe(true);
    expect(logs.ok, JSON.stringify(logs)).toBe(true);
    expect(session.ok && session.value?.epoch).toBe(occupied!.epoch);
    expect(pasteCount.ok, JSON.stringify(pasteCount)).toBe(true);
    if (!pasteCount.ok) throw new Error(pasteCount.error);
    expect(pasteCount.value, "One mail paste per sent message").toBe(messageId2 === undefined ? 1 : 2);
    expect(finalOutcome?.kind).toBe("read");
    expect(finalOutcome?.deliveredAt).toBeDefined();
    if (messageId2 !== undefined) {
      expect(mail2.ok, JSON.stringify(mail2)).toBe(true);
      expect(finalOutcome2?.kind).toBe("read");
      expect(finalOutcome2?.deliveredAt).toBeDefined();
    }
    expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(qualificationAtStart);
  } finally {
    await junto.close();
  }
});
