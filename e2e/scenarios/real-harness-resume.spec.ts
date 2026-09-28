/**
 * Real-harness session resume [real-harness, opt-in, spends tokens].
 *   JUNTO_REAL_RESUME=1 bun run test:e2e:fast e2e/scenarios/real-harness-resume.spec.ts
 *   JUNTO_REAL_RESUME=claude,codex …   (only these harnesses)
 * Build the app with JUNTO_FEATURE_PROFILE=all-on first, and add
 * JUNTO_HARNESS_KIMI=1 so this process's authoring factory admits Kimi too.
 *
 * For each harness CLI installed on this machine: seat it on a playing canvas,
 * send it a code word as operator prompt mail, capture the seat's session id,
 * kill the PTY, then send a second prompt. Delivery cold-wakes the seat, the
 * host must report the generation as `resuming`, and the reply must recall the
 * code word — the same conversation, not a fresh one that guessed.
 *
 * Harness CLIs run on the operator's real HOME so they keep their own logins.
 * Junto state is a throwaway tree (JUNTO_HOME) that owns every session on it
 * (JUNTO_HOME_OWNS_SESSIONS=1); the operator's ~/.junto is never opened.
 * Each harness writes its verdict, CLI version and cause to
 * $JUNTO_RESUME_MATRIX_DIR (default /tmp/junto-resume-matrix/<harness>.json).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { ManagedLaunchChoices } from "../../src/shared/managed-terminal-launch";
import { buildManagedAgentSeat } from "../../src/renderer/lib/node-factories";
import { templateFor, type HarnessId } from "../../src/shared/managed-terminal-templates";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import { juntoLogDirectory } from "../../src/shared/junto-logs";
import { expect, launchJunto, test } from "../harness/launch";

type Case = {
  readonly harness: HarnessId;
  /** Cheapest model / effort this harness accepts. */
  readonly choices?: ManagedLaunchChoices;
};

// The operator's top six, gold standard first. Amp, Hermes, Muse, fx, OMP,
// Devin, Antigravity and Prime Agent are out of scope for this suite.
const CASES: readonly Case[] = [
  { harness: "claude", choices: { model: "haiku" } },
  { harness: "codex", choices: { effort: "low" } },
  { harness: "grok", choices: { effort: "low" } },
  { harness: "cursor", choices: { model: "composer-2.5" } },
  { harness: "kimi" },
  { harness: "pi", choices: { effort: "off" } },
];

const OPT_IN = process.env.JUNTO_REAL_RESUME?.trim() ?? "";
const selected = (harness: string): boolean =>
  OPT_IN === "1" || OPT_IN.split(",").map((s) => s.trim()).includes(harness);
const MATRIX_DIR =
  process.env.JUNTO_RESUME_MATRIX_DIR ?? join("/tmp", "junto-resume-matrix");
const OPERATOR_HOME = homedir();

const which = (binary: string): string | undefined => {
  try {
    return execFileSync("/usr/bin/which", [binary], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};

const versionOf = (binary: string): string => {
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n")[0]!
      .slice(0, 120);
  } catch (error) {
    return `unknown (${String(error).slice(0, 80)})`;
  }
};

// Strip CSI / OSC / charset escapes from xterm's serialized VT state.
const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-9A-Za-z]|\u001b[=>78MDEc]/g;

type Api = {
  listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
  readCanvas: (n: string) => Promise<{ doc: CanvasDoc; revision: string }>;
  writeCanvas: (n: string, d: CanvasDoc, r: string) => Promise<unknown>;
  terminalGet: (b: string) => Promise<TerminalSessionSummary | undefined>;
  terminalKill: (b: string) => Promise<boolean>;
  terminalAttach: (i: { bindingId: string; mode: "observe" | "control"; takeover?: boolean }) => Promise<unknown>;
  terminalRelease: (l: string) => Promise<boolean>;
  agentSeatStateSnapshot: () => Promise<ReadonlyArray<{ bindingId: string; state: string; reason: string; confidence: string }>>;
  terminalWrite: (l: string, d: string) => Promise<boolean>;
  terminalManagedPrompt: (i: {
    bindingId: string;
    text: string;
    canvasName: string;
    nodeId: string;
    wake: boolean;
  }) => Promise<{ ok: boolean; disposition: string; error?: string }>;
};

/** Visible screen of the seat's live generation, escapes stripped. */
const screenOf = async (page: Page, bindingId: string): Promise<string> => {
  const raw = await page.evaluate(async (id) => {
    const api = (window as unknown as { junto: Api }).junto;
    const attached = (await api.terminalAttach({ bindingId: id, mode: "observe" })) as {
      ok: boolean;
      lease?: { leaseId: string };
      screen?: { serialized: string };
    };
    if (!attached.ok) return "";
    if (attached.lease) await api.terminalRelease(attached.lease.leaseId);
    return attached.screen?.serialized ?? "";
  }, bindingId);
  // Serialized rows advance over blanks with CUF; keep them as spaces.
  return raw
    .replace(/\u001b\[(\d*)C/g, (_m, n: string) => " ".repeat(Number(n || "1")))
    .replace(ESCAPES, "")
    .replace(/\r/g, "");
};

/** Type into the seat as the operator would (trust / first-run prompts). */
const operatorKeys = async (page: Page, bindingId: string, data: string): Promise<void> => {
  await page.evaluate(
    async ([id, keys]) => {
      const api = (window as unknown as { junto: Api }).junto;
      const attached = (await api.terminalAttach({
        bindingId: id!,
        mode: "control",
        takeover: true,
      })) as { ok: boolean; lease?: { leaseId: string } };
      if (!attached.ok || !attached.lease) return;
      await api.terminalWrite(attached.lease.leaseId, keys!);
      await api.terminalRelease(attached.lease.leaseId);
    },
    [bindingId, data] as const,
  );
};

const TRUST_PROMPT =
  /(do you trust|trust (?:the )?(?:files|folder|this (?:folder|directory|workspace))|trust this|one you trust)/i;
const SELECTED_LINE = /^\s*[❯›>▶→]\s*(?:\d+[.)]\s*)?(.*)$/m;

/**
 * Keys that accept a trust prompt: confirm when the selector already sits on
 * a yes, else step down one option (next poll looks again).
 */
const trustKeys = (screen: string): string => {
  const selected = screen.match(SELECTED_LINE)?.[1] ?? "";
  if (/\b(no|exit|quit|cancel)\b/i.test(selected)) return "\u001b[B";
  return "\r";
};

type Verdict = {
  harness: string;
  binary: string;
  version: string;
  result: "pass" | "fail" | "skip";
  cause: string;
  sessionId?: string;
  resumedSessionId?: string;
  resuming?: boolean;
  /** How the resumed generation ended, when it died before replying. */
  resumedExit?: string;
  recalled?: boolean;
  firstArgv?: readonly string[];
  at: string;
};

const record = (verdict: Verdict): void => {
  mkdirSync(MATRIX_DIR, { recursive: true });
  writeFileSync(
    join(MATRIX_DIR, `${verdict.harness}.json`),
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
};

const randomDigits = (n: number): string =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

for (const c of CASES) {
  const template = templateFor(c.harness);
  const binary = template.argvSpec.binary;

  test(`real ${c.harness} resumes its own conversation after a cold kill`, async () => {
    test.skip(!selected(c.harness), "opt-in: JUNTO_REAL_RESUME=1 or a harness list");
    const path = which(binary);
    if (path === undefined) {
      record({
        harness: c.harness,
        binary,
        version: "not installed",
        result: "skip",
        cause: `${binary} not on PATH`,
        at: new Date().toISOString(),
      });
      test.skip(true, `${binary} not installed`);
      return;
    }
    test.setTimeout(900_000);
    mkdirSync(MATRIX_DIR, { recursive: true });
    const verdict: Verdict = {
      harness: c.harness,
      binary: path,
      version: versionOf(path),
      result: "fail",
      cause: "did not finish",
      at: new Date().toISOString(),
    };
    test.info().annotations.push({ type: "cli", description: `${binary} ${verdict.version}` });

    // A fixed per-harness folder: harness trust grants persist across runs,
    // and no other agent works there, so after-the-fact capture sees only
    // this seat's sessions.
    const folder = join("/tmp", "junto-resume-proof", c.harness);
    mkdirSync(folder, { recursive: true });
    // Harnesses key trust by the resolved path (/private/tmp on macOS).
    const cwd = realpathSync(folder);
    const seatId = `resume-${c.harness}`;
    // The operator's authoring path: it mints the pin a pin harness needs.
    const seat = buildManagedAgentSeat({
      harness: c.harness,
      host: "local",
      cwd,
      ...(c.choices?.model ? { model: c.choices.model } : {}),
      ...(c.choices?.effort ? { effort: c.choices.effort } : {}),
      label: `${c.harness} resume proof`,
    });
    const bindingId = seat.ether.terminal!.bindingId;
    const launch = seat.ether.terminal!.launch!;
    verdict.firstArgv = launch.argv;

    const extraEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: OPERATOR_HOME,
      SHELL: process.env.SHELL ?? "/bin/zsh",
      JUNTO_HOME_OWNS_SESSIONS: "1",
      JUNTO_PTY_TRACE: "1",
    };
    const junto = await launchJunto({
      // The sandbox tree becomes Junto's home; HOME stays the operator's.
      afterSeed: async (sandbox) => {
        extraEnv.JUNTO_HOME = sandbox.homeDir;
      },
      extraEnv,
    });
    const mainLog: string[] = [];
    const proc = junto.app.process();
    proc.stdout?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
    proc.stderr?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
    const seatLog = (): string =>
      mainLog
        .join("")
        .split("\n")
        .filter((line) => /\[(wake|delivery|term|capture|session)/i.test(line) || line.includes(bindingId))
        .slice(-40)
        .join("\n");

    const { page } = junto;
    const get = (): Promise<TerminalSessionSummary | undefined> =>
      page.evaluate(
        async (id) => (window as unknown as { junto: Api }).junto.terminalGet(id),
        bindingId,
      );
    let canvas = "";
    const sessionIdOnNode = async (): Promise<string | undefined> => {
      const read = await page.evaluate(
        async (name) => (window as unknown as { junto: Api }).junto.readCanvas(name),
        canvas,
      );
      return read.doc.nodes.find((n) => n.id === seatId)?.ether?.terminal?.sessionId;
    };
    const prompt = (text: string) =>
      page.evaluate(
        async ([id, body, name, node]) =>
          (window as unknown as { junto: Api }).junto.terminalManagedPrompt({
            bindingId: id!,
            text: body!,
            canvasName: name!,
            nodeId: node!,
            wake: true,
          }),
        [bindingId, text, canvas, seatId] as const,
      );
    const trustLog: string[] = [];
    /** Seat state and this seat's mailbox receipts, for a failure message. */
    const diagnosis = async (): Promise<string> =>
      page.evaluate(
        async ([id, name, node]) => {
          const api = (window as unknown as { junto: Api }).junto;
          const states = (await api.agentSeatStateSnapshot()).filter((s) => s.bindingId === id);
          const read = await api.readCanvas(name!);
          const mail = (read.doc.nodes.find((n) => n.id === node)?.ether?.messages?.items ?? []).map(
            (m) => ({ id: m.messageId, meta: m.metadata }),
          );
          return JSON.stringify({ states, mail }, null, 1);
        },
        [bindingId, canvas, seatId] as const,
      ).then((text) => `${text}\ntrust keys: ${trustLog.join(", ") || "none"}`);
    /** Poll the screen for `pattern`, answering trust prompts on the way. */
    const waitForScreen = async (pattern: RegExp, timeoutMs: number, what: string): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      let trustAnswered = 0;
      while (Date.now() < deadline) {
        last = await screenOf(page, bindingId);
        if (pattern.test(last)) return last;
        if (TRUST_PROMPT.test(last) && trustAnswered < 6) {
          trustAnswered += 1;
          trustLog.push(`${String(Date.now())} ${JSON.stringify(trustKeys(last))}`);
          await operatorKeys(page, bindingId, trustKeys(last));
        }
        await page.waitForTimeout(1_500);
      }
      writeFileSync(join(MATRIX_DIR, `${c.harness}.screen.txt`), `${what}\n${last}`);
      throw new Error(`${what}: never saw ${String(pattern)}.\n[screen]\n${last}\n[seat]\n${await diagnosis()}\n[main log]\n${seatLog()}`);
    };

    try {
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      const seatDoc: CanvasDoc = {
        nodes: [
          {
            id: seatId,
            type: "text",
            text: seat.text,
            x: 360,
            y: 40,
            width: 240,
            height: 96,
            ether: seat.ether,
          },
        ],
        edges: [],
      };
      canvas = await page.evaluate(
        (doc) =>
          (async () => {
            const api = (window as unknown as { junto: Api }).junto;
            const name = (await api.listCanvases())[0]!.name;
            const read = await api.readCanvas(name);
            await api.writeCanvas(name, doc, read.revision);
            return name;
          })(),
        seatDoc,
      );
      await expect(page.locator(`.react-flow__node[data-id="${seatId}"]`)).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: "Play canvas" }).click();
      await page
        .getByRole("dialog", { name: /start|first|play|crew/i })
        .getByRole("button", { name: "play" })
        .click();
      await expect(page.getByRole("button", { name: "Pause canvas" })).toBeVisible({
        timeout: 15_000,
      });

      // Turn 1 — the code word. The ack is arithmetic so the reply is
      // distinguishable from the echoed prompt. Plain wording: seat doctrine
      // teaches models to refuse mail that reads like injected orders.
      const token = `ORCHID${randomDigits(5)}`;
      const addend = 100 + Math.floor(Math.random() * 800);
      const ack = String(3000 + addend);
      const first = await prompt(
        `Quick memory game for this chat: the word to keep is ${token}, I will ask for it in my next message. For now, just tell me what 3000 + ${String(addend)} is, as a bare number.`,
      );
      expect(first.ok, `turn 1 prompt: ${first.error ?? ""}`).toBe(true);
      await waitForScreen(new RegExp(`(^|\\D)${ack}(\\D|$)`), 180_000, "turn 1 reply");

      await expect
        .poll(sessionIdOnNode, { timeout: 60_000, intervals: [1_000, 2_000, 5_000] })
        .toBeTruthy()
        .catch((cause: unknown) => {
          throw new Error(`session id never landed on the seat.\n[main log]\n${seatLog()}`, { cause });
        });
      const sessionId = (await sessionIdOnNode())!;
      verdict.sessionId = sessionId;
      const firstGen = await get();

      // Cold: kill the PTY. Nothing of the first generation survives but the
      // id on the node and the harness's own store.
      await page.evaluate(
        async (id) => (window as unknown as { junto: Api }).junto.terminalKill(id),
        bindingId,
      );
      await expect
        .poll(async () => (await get())?.status ?? "gone", { timeout: 30_000 })
        .not.toBe("running");

      // Turn 2 — delivery wakes the seat on its stored session.
      const second = await prompt(
        "Memory game, part two: which word did I give you for the memory game earlier in this chat? Answer as RECALL- followed by the word, with nothing else.",
      );
      expect(second.ok, `turn 2 prompt: ${second.error ?? ""}`).toBe(true);
      await expect
        .poll(async () => {
          const live = await get();
          return live?.status === "running" && live.epoch !== firstGen?.epoch;
        }, { timeout: 120_000 })
        .toBe(true);
      const resumedGen = await get();
      verdict.resuming = resumedGen?.resuming === true;

      let recalled = false;
      try {
        await waitForScreen(new RegExp(`RECALL-${token}`), 300_000, "turn 2 reply");
        recalled = true;
      } catch (error) {
        const after = await get();
        verdict.resumedExit =
          after?.status === "exited"
            ? `exited: ${after.exitMessage ?? after.exitReason ?? "no message"}`
            : after?.status;
        verdict.cause = String(error).slice(0, 600);
      }
      verdict.recalled = recalled;
      verdict.resumedSessionId = await sessionIdOnNode();

      const causes: string[] = [];
      if (!verdict.resuming) causes.push("host did not report the second generation as resuming");
      if (!recalled) causes.push("reply did not recall the code word");
      if (verdict.resumedSessionId !== sessionId) {
        causes.push(`node session changed ${sessionId} -> ${String(verdict.resumedSessionId)}`);
      }
      verdict.result = causes.length === 0 ? "pass" : "fail";
      verdict.cause = causes.length === 0 ? "resumed and recalled" : `${causes.join("; ")}. ${verdict.cause === "did not finish" ? "" : verdict.cause}`.trim();
      expect(causes, seatLog()).toEqual([]);
    } catch (error) {
      if (verdict.result !== "fail" || verdict.cause === "did not finish") {
        verdict.result = "fail";
        verdict.cause = String(error).split("\n").slice(0, 3).join(" ").slice(0, 400);
      }
      throw error;
    } finally {
      record(verdict);
      // Evidence survives the sandbox: the whole main log and the delivery
      // trace for this seat.
      writeFileSync(join(MATRIX_DIR, `${c.harness}.main.log`), mainLog.join(""));
      const logs = juntoLogDirectory(junto.sandbox.homeDir);
      if (existsSync(logs)) cpSync(logs, join(MATRIX_DIR, `${c.harness}.logs`), { recursive: true });
      await junto.close();
    }
  });
}
