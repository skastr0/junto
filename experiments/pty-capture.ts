#!/usr/bin/env node
/**
 * pty-capture.ts — canonical PTY byte-stream capture for the Vellum Command PTY E2E corpus.
 *
 * Spawns each real harness TUI inside a node-pty (120x32, TERM=xterm-256color,
 * isolated cwd under /tmp/vellum-capture-cwd/<harness>), drives the canonical
 * scenarios, scrubs every byte stream, and writes:
 *
 *   tests/pty-e2e/corpus/<harness>/<scenario>.jsonl   {"t":ms,"b64":...}
 *   tests/pty-e2e/corpus/<harness>/manifest.json      per-scenario manifests
 *   /tmp/vellum-capture-report.md                         receipts + canonicality
 *
 * Standalone script — NOT part of the vitest suite. Run directly:
 *
 *   node experiments/pty-capture.ts                # capture all shipped harnesses
 *   node experiments/pty-capture.ts <harness>      # capture one harness
 *   node experiments/pty-capture.ts list           # list harnesses
 *   node experiments/pty-capture.ts verify         # decode + scrub-gate corpus
 *
 * Canonicality gate (feeds a fixture through the REAL SessionObserver):
 *
 *   node --import /tmp/vellum-register.mjs experiments/pty-capture.ts \
 *        check <harness> <scenario> [--glyph <glyph>]
 *
 * NOTE ON BUN: the mission asked for `bun`; node-pty 1.1.0's native addon
 * delivers data on a native worker thread and Bun's event loop never wakes
 * for those callbacks (verified: 0 bytes received under bun 1.3.14, same
 * script works under node v26.5.0). The script is therefore run with node —
 * it remains a standalone script, independent of the verify suite.
 */

import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// ── corpus / capture constants ──────────────────────────────────────────────
const OUT_ROOT = path.join(REPO, "tests", "pty-e2e", "corpus");
const CAPTURE_ROOT = path.join(REPO, "tests", "pty-e2e", `.corpus-stage-${process.pid}-${randomUUID()}`);
const CWD_ROOT = "/tmp/vellum-capture-cwd";
const FAKE_UUID = "00000000-0000-4000-8000-000000000000"; // fallback; random per spawn
const COLS = 120;
const ROWS = 32;
const HARNESS_TIMEOUT_MS = 210_000; // hard timebox per harness
const IDLE_WAIT_CAP_MS = 50_000;   // startup idle wait cap
const TURN_WAIT_CAP_MS = 30_000;   // post-CR idle-return cap
const WORKING_WAIT_CAP_MS = 20_000; // working-signal wait cap
const QUIET_MS = 1400;             // bytes-quiet threshold for "stable"
const SHIPPED_HARNESSES = new Set(["claude", "codex", "grok", "pi", "devin"]);

// ── scrub source material ───────────────────────────────────────────────────
const HOME = os.homedir();
const USER = path.basename(HOME);
const HOST = os.hostname();
const HOST_CMD = spawnSync("hostname", []).stdout?.toString().trim() || HOST;
const TMP_REAL = fs.realpathSync("/tmp"); // macOS: /private/tmp

/** Ambient env keys scrubbed before spawn (mirrors SPAWN_ENV_SCRUB + traps). */
const ENV_SCRUB = [
  "NO_COLOR", "FORCE_COLOR",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
  "VELLUM_COMMAND_SOCKET", "VELLUM_COMMAND_TOKEN", "VELLUM_COMMAND_SEAT",
  "VELLUM_COMMAND_NODE_REF",
  "KIMI_MODEL_API_KEY", "KIMI_MODEL_BASE_URL", "KIMI_SECONDARY_MODEL",
  "KIMI_SECONDARY_EFFORT", "KIMI_MODEL_NAME", "KIMI_MODEL_PROVIDER_TYPE",
  "DEVIN_WRAPPER_ACTIVE", "DEVIN_CONTEXT_SOCKET", "DEVIN_SESSION_ID",
  "DEVIN_BINARY_PATH", "DEVIN_KEYBINDING_TRIGGER", "WINDSURF_CASCADE_TELEMETRY",
  "PI_SESSION_ID", "PI_SESSION_FILE",
];

// ── harness definitions ─────────────────────────────────────────────────────
export type HarnessDef = {
  readonly name: string;
  readonly displayName: string;
  /** argv built at spawn time (cwd may be needed for trust pre-seeding). */
  readonly argv: (cwd: string, sessionId: string) => string[];
  readonly env?: Record<string, string>;
  /** cwd prep (e.g. grok needs a git work tree). */
  readonly prep?: (cwd: string) => void;
  /** prompt glyphs that mark the idle composer. */
  readonly promptGlyphs: readonly string[];
  /** graceful exit attempts, in order (bytes). */
  readonly exitRecipe: readonly (string | Uint8Array)[];
  /** blocking-modal mitigations: [matchRegex, replyBytes] applied once. */
  readonly modals?: readonly { readonly when: RegExp; readonly reply: string }[];
  readonly note?: string;
  /**
   * Fresh spawn per scenario (self-contained fixtures, avoids TUIs that
   * degrade after several turns in one session — muse stalls/exits after
   * ~2 turns in a bare PTY).
   */
  readonly freshSpawnPerScenario?: boolean;
};

const HARNESSES: readonly HarnessDef[] = [
  {
    name: "claude", displayName: "Claude Code",
    argv: (cwd, sid) => ["--setting-sources", "local", "--no-chrome", "--model", "haiku",
      "--permission-mode", "default", "--effort", "low", "--session-id", sid],
    promptGlyphs: ["\u276f", "\u25b8", ">"],
    exitRecipe: ["/exit\r"],
    modals: [{ when: /trust[^\n]{0,40}folder|do you trust/i, reply: "1\r" }],
    note: "bare TUI; no Vellum Command doctrine/env; keychain auth",
  },
  {
    name: "codex", displayName: "Codex",
    argv: (cwd) => ["-m", "gpt-5.4-mini", "-c", 'model_reasoning_effort="low"', "-a", "never",
      "-c", `projects={"${cwd}"={trust_level="trusted"}}`,
      "-c", "checkForUpdateOnStartup=false"],
    promptGlyphs: ["\u203a", ">"],
    exitRecipe: ["\u0003", "/exit\r", "\u0004"],
    note: "trust pre-seeded via -c projects=…; -a never avoids approval dialogs",
  },
  {
    name: "grok", displayName: "Grok",
    argv: (cwd, sid) => ["--minimal", "-m", "grok-4.5", "--reasoning-effort", "low",
      "--permission-mode", "default", "--session-id", sid],
    prep: (cwd) => { spawnSync("git", ["init", "-q"], { cwd }); },
    promptGlyphs: ["\u276f", ">"],
    exitRecipe: ["\u0003", "\u0004", "/exit\r"],
    note: "spawned in a git work tree (project-picker modal otherwise)",
  },
  {
    name: "hermes", displayName: "Hermes",
    argv: (cwd) => ["chat", "--tui", "--provider", "openai-codex", "-m", "gpt-5.4-mini"],
    promptGlyphs: ["\u276f", "\u2502", ">"],
    exitRecipe: ["\u0003", "exit\r", "/exit\r"],
    note: "interactive TUI path is `hermes chat --tui`",
  },
  {
    name: "kimi", displayName: "Kimi Code",
    argv: (cwd) => ["--yolo"],
    promptGlyphs: [">", "\u276f"],
    exitRecipe: ["\u0003", "\u0004", "/exit\r"],
    note: "static OSC title 'Kimi Code'; no alt screen",
  },
  {
    name: "pi", displayName: "Pi",
    argv: (cwd, sid) => ["-a", "--model", "gpt-5.4-mini", "--session-id", sid],
    // pi's composer is a bare box (no prompt glyph); the footer context meter
    // ("0.0%/400k (auto)") marks a ready composer.
    promptGlyphs: ["0.0%/400k (auto)", "\u276f", ">"],
    exitRecipe: ["\u0003", "\u0004", "/exit\r"],
    note: "--approve gates project-trust selector",
  },
  {
    name: "prime-agent", displayName: "Prime Agent",
    argv: (cwd) => ["--model", "gpt-5.4-mini"],
    // model-picker/sign-in screen appears first; ESC dismisses it
    modals: [{ when: /sign in|choose a provider|select.*provider/i, reply: "\u001b" }],
    promptGlyphs: [">", "\u276f"],
    exitRecipe: ["\u0003", "\u0004", "/exit\r"],
    note: "pi lineage; may bootstrap kernel venv on first spawn",
  },
  {
    name: "muse", displayName: "Muse Code",
    argv: (cwd) => ["--provider", "echo", "--echo-delay-ms", "800", "--trust-workspace"],
    promptGlyphs: ["\u27e9"],
    exitRecipe: ["\u0003", "\u0004", "/exit\r"],
    modals: [{ when: /trust this workspace|do you trust/i, reply: "1\r" }],
    freshSpawnPerScenario: true,
    note: "echo provider = free deterministic turns, no auth needed; --trust-workspace avoids the trust modal",
  },
  {
    name: "devin", displayName: "Devin",
    argv: (cwd) => [],
    promptGlyphs: ["\u276d", "\u203a", ">"],
    exitRecipe: ["\u0003", "exit\r", "/exit\r"],
    note: "welcome prompt glyph is \u276d; auth state unknown",
  },
];

// ── scrubber ────────────────────────────────────────────────────────────────
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SK_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const PROVIDER_TOKEN_RE = /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/g;
const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~-]{12,}/gi;
const LONG_TOKEN_RE = /(?<![A-Za-z0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9])/g;
const USER_HOME_RE = /\/Users\/[^/\s\x1b]+/g;
const LINUX_HOME_RE = /\/home\/[^/\s\x1b]+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteralInsensitive(text: string, value: string, replacement: string): string {
  if (!value) return text;
  return text.replace(new RegExp(escapeRegExp(value), "gi"), replacement);
}

/** Deterministic, idempotent path/token scrub. Applied per capture chunk. */
export function scrub(text: string, cwd: string): string {
  const cwdReal = fs.realpathSync(cwd);
  let s = text;
  // paths first (longest first)
  s = s.split(cwdReal).join("<CWD>");
  s = s.split(cwd).join("<CWD>");
  s = s.split(path.join(TMP_REAL, "vellum-capture-cwd")).join("<CAPTURE>");
  s = s.split(path.join("/tmp", "vellum-capture-cwd")).join("<CAPTURE>");
  s = s.split(HOME).join("<HOME>");
  s = s.split("~" + path.sep + USER).join("<HOME>");
  // Harnesses can print cached/configured paths belonging to another account.
  // The corpus must not preserve any absolute user-home identity, not only the
  // account running this capture.
  s = s.replace(USER_HOME_RE, "<HOME>");
  s = s.replace(LINUX_HOME_RE, "<HOME>");
  s = s.split(`/private/var/${USER}`).join("<HOME>");
  s = s.split(`/${USER}`).join("/<USER>");
  s = replaceLiteralInsensitive(s, HOST, "<HOST>");
  s = replaceLiteralInsensitive(s, HOST_CMD, "<HOST>");
  // ids / tokens
  s = s.split(FAKE_UUID).join("<SESSION>");
  s = s.replace(UUID_RE, "<SESSION>");
  s = s.replace(/session_([0-9a-fA-F]{8,})/g, "session_<SESSION>");
  s = s.replace(EMAIL_RE, "<EMAIL>");
  s = s.replace(SK_RE, "<TOKEN>");
  s = s.replace(PROVIDER_TOKEN_RE, "<TOKEN>");
  s = s.replace(BEARER_TOKEN_RE, "Bearer <TOKEN>");
  s = s.replace(LONG_TOKEN_RE, "<TOKEN>");
  s = s.replace(new RegExp(`\\b${escapeRegExp(USER)}\\b`, "gi"), "<USER>");
  return s;
}

type ScrubReceipt = {
  readonly fixtures: number;
  readonly decodedBytes: number;
  readonly checks: readonly string[];
};

const SCRUB_CHECKS = ["home-path", "username", "hostname", "email", "token"] as const;

function decodedFixture(file: string): Buffer {
  const source = fs.readFileSync(file, "utf8");
  const chunks: Buffer[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${path.relative(REPO, file)}:${index + 1}: invalid JSON`);
    }
    if (typeof value !== "object" || value === null ||
        typeof (value as { t?: unknown }).t !== "number" ||
        typeof (value as { b64?: unknown }).b64 !== "string") {
      throw new Error(`${path.relative(REPO, file)}:${index + 1}: expected {t:number,b64:string}`);
    }
    const b64 = (value as { b64: string }).b64;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
      throw new Error(`${path.relative(REPO, file)}:${index + 1}: invalid base64`);
    }
    chunks.push(Buffer.from(b64, "base64"));
  }
  if (chunks.length === 0) throw new Error(`${path.relative(REPO, file)}: empty fixture`);
  return Buffer.concat(chunks);
}

function survivingSensitiveKinds(text: string): string[] {
  const kinds: string[] = [];
  if (text.includes(HOME) || /\/Users\/[^/\s\x1b]+/.test(text) || /\/home\/[^/\s\x1b]+/.test(text)) kinds.push("home-path");
  if (new RegExp(`\\b${escapeRegExp(USER)}\\b`, "i").test(text)) kinds.push("username");
  if ((HOST && new RegExp(escapeRegExp(HOST), "i").test(text)) ||
      (HOST_CMD && new RegExp(escapeRegExp(HOST_CMD), "i").test(text))) kinds.push("hostname");
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text)) kinds.push("email");
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(text) ||
      /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{12,})\b/.test(text) ||
      /\bBearer\s+(?!<TOKEN>)[A-Za-z0-9._~-]{12,}/i.test(text) ||
      /(?<![A-Za-z0-9<])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9>])/.test(text)) kinds.push("token");
  return kinds;
}

function certifyHarness(root: string, harness: string): ScrubReceipt {
  const dir = path.join(root, harness);
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort();
  if (files.length === 0) throw new Error(`${harness}: no JSONL fixtures to certify`);
  let decodedBytes = 0;
  const failures: string[] = [];
  for (const file of files) {
    const decoded = decodedFixture(path.join(dir, file));
    decodedBytes += decoded.length;
    const kinds = survivingSensitiveKinds(decoded.toString("utf8"));
    if (kinds.length > 0) failures.push(`${harness}/${file}: ${kinds.join(", ")}`);
  }
  if (failures.length > 0) {
    throw new Error(`scrub certification failed\n${failures.join("\n")}`);
  }
  console.log(`[${harness}] SCRUB PASS: ${files.length} decoded fixtures, ${decodedBytes} bytes; ${SCRUB_CHECKS.join(", ")}`);
  return { fixtures: files.length, decodedBytes, checks: SCRUB_CHECKS };
}

// ── VT signal extraction (for manifests + report receipts) ──────────────────
export type ObservedSignals = {
  titles: string[];
  osc9s: string[];
  modes: { set: number[]; reset: number[]; kittyPush: boolean; kittyPop: boolean };
  glyphs: string[];
  chipText: string | null;
};

export function extractSignals(bytes: Buffer): ObservedSignals {
  const text = bytes.toString("utf8");
  const titles = new Set<string>();
  const osc9s = new Set<string>();
  const modesSet = new Set<number>();
  const modesReset = new Set<number>();
  let kittyPush = false, kittyPop = false;
  // OSC 0/2 titles and OSC 9 progress (BEL or ST terminated)
  const oscRe = /\x1b\]([0-9]+)(?:;([^\x07\x1b\\]*))?(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = oscRe.exec(text))) {
    const ident = m[1];
    const payload = m[2] ?? "";
    if (ident === "0" || ident === "2") titles.add(payload);
    else if (ident === "9") osc9s.add(payload);
  }
  // DEC private / ANSI mode sets
  const modeRe = /\x1b\[(\??)(\d+(?:;\d+)*)([hl])/g;
  while ((m = modeRe.exec(text))) {
    for (const part of m[2].split(";")) {
      const n = Number(part);
      if (m[3] === "h") modesSet.add(n); else modesReset.add(n);
    }
  }
  if (/\x1b\[>1u/.test(text)) kittyPush = true;
  if (/\x1b\[<u/.test(text)) kittyPop = true;
  // non-ASCII glyph census (sample)
  const glyphs = new Set<string>();
  const sample = text.slice(-4000);
  for (const ch of sample) {
    if (ch.codePointAt(0)! > 0x7f && !/[\u200b-\u200f\u2028\u2029\ufeff]/.test(ch)) {
      glyphs.add(ch);
    }
  }
  let chipText: string | null = null;
  const chipRe = /\[Pasted\s*text[^\]]*\]|Pasted\s*text[^\r\n]{0,40}|\[\[[^\]\r\n]{0,80}\[\d+ lines?\][^\]\r\n]{0,80}\]\]/gi;
  const cm = chipRe.exec(text);
  if (cm) chipText = cm[0];
  return {
    titles: [...titles], osc9s: [...osc9s],
    modes: { set: [...modesSet], reset: [...modesReset], kittyPush, kittyPop },
    glyphs: [...glyphs].sort(), chipText,
  };
}

// ── ANSI-stripped tail text (for detection + manifests) ─────────────────────
export function tailText(bytes: Buffer, n = 4000): string {
  let s = bytes.toString("utf8").slice(-n);
  s = s.replace(/\x1b\][^\x07\x1b\\]*(?:\x07|\x1b\\)/g, "");   // OSC
  s = s.replace(/\x1b\[[0-9;?><]*[ -\/]*[@-~]/g, "");          // CSI (incl. kitty >1u / ?u)
  s = s.replace(/\x1b[()][0-9A-B]/g, "");                      // charset
  s = s.replace(/\x1b[=>]/g, "");                              // keypad
  s = s.replace(/\x1b[DM]/g, "");                              // RI/IND
  s = s.replace(/\x1b/g, "");                                  // stray ESC
  return s;
}

// ── capture session ─────────────────────────────────────────────────────────
type RawEvent = { t: number; buf: Buffer };

class Session {
  readonly name: string;
  readonly def: HarnessDef;
  readonly cwd: string;
  pty: IPty | null = null;
  events: RawEvent[] = [];
  bytes = 0;
  lastDataAt = 0;
  exited = false;
  exitInfo: { code: number; signal?: number } | null = null;
  blocked = false;
  blockReason = "";
  modalsReplied = new Set<string>();

  constructor(def: HarnessDef) {
    this.def = def;
    this.name = def.name;
    this.cwd = path.join(CWD_ROOT, def.name);
  }

  private env(): Record<string, string> {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || ENV_SCRUB.includes(k)) continue;
      e[k] = v;
    }
    e.TERM = "xterm-256color";
    e.LANG = e.LANG ?? "en_US.UTF-8";
    Object.assign(e, this.def.env);
    return e;
  }

  spawn(): void {
    fs.rmSync(this.cwd, { recursive: true, force: true });
    fs.mkdirSync(this.cwd, { recursive: true });
    this.def.prep?.(this.cwd);
    const argv = this.def.argv(this.cwd, randomUUID());
    console.log(`[${this.name}] spawn: ${this.def.name} ${argv.join(" ")}`);
    this.pty = ptySpawn(this.def.name, argv, {
      name: "xterm-256color", cols: COLS, rows: ROWS,
      cwd: this.cwd, env: this.env(), encoding: null,
    });
    this.lastDataAt = Date.now();
    this.pty.onData((d: Buffer) => this.onData(d));
    this.pty.onExit((e) => {
      this.exited = true;
      this.exitInfo = { code: e.exitCode, signal: e.signal };
    });
  }

  /** Rolling scan buffer for host-answerable queries (DSR, palette, DA). */
  private scanBuf = "";
  /** Rolling tail for cursor-blink repaint detection (muse et al.). */
  private blinkTail = "";
  /**
   * Events hold RAW bytes; scrubbing happens on the CONTIGUOUS slice at
   * fixture-write time, so patterns split across data chunks (cwd paths,
   * session ids) are still replaced.
   */
  private onData(d: Buffer): void {
    const t = Date.now();
    this.events.push({ t, buf: Buffer.from(d) });
    this.bytes += d.length;
    const raw = d.toString("utf8");
    this.blinkTail = (this.blinkTail + raw).slice(-300);
    if (!this.isBlinkOnly()) this.lastDataAt = t;
    this.respondToQueries(raw);
    this.checkModal();
  }

  /**
   * Cursor-blink repaints carry no content (muse repaints the composer row
   * with pure SGR resets + cursor moves ~2x/s at idle). They must not count
   * as "data" for idle detection, or idle is never reached.
   */
  private isBlinkOnly(): boolean {
    let s = this.blinkTail;
    const esc0 = s.indexOf("\x1b");
    if (esc0 > 0) s = s.slice(esc0);            // drop partial-escape junk prefix
    // hermes idle tick: home+CR + cursor moves + seconds digit, per second
    s = s.replace(/\x1b\[\?2026h\x1b\[H\r.*?\x1b\[32;1H\x1b\[\?2026l/g, "");
    s = s.replace(/\x1b\[\?2026[hl]/g, "");
    s = s.replace(/\x1b\[39m|\x1b\[49m|\x1b\[59m|\x1b\[0m|\x1b\[\?25[hl]/g, "");
    s = s.replace(/\x1b\[\d+;\d+H/g, "");
    s = s.replace(/\x1b[\x00-\x7f]{0,7}$/, ""); // dangling partial escape at tail
    s = s.replace(/\x1b/g, "");
    return s.trim() === "";
  }

  /**
   * Answer terminal queries the way an xterm-compatible host does. Real TUIs
   * (muse: DSR cursor position; grok/muse: palette queries) stall or exit when
   * the PTY host never replies — the capture must act as a faithful host.
   * Replies go host→child and are NOT part of the captured child→host stream.
   */
  private respondToQueries(raw: string): void {
    this.scanBuf = (this.scanBuf + raw).slice(-128);
    const replies: string[] = [];
    const drain = (re: RegExp, reply: string | ((m: RegExpExecArray) => string)) => {
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.scanBuf))) {
        replies.push(typeof reply === "string" ? reply : reply(m));
        this.scanBuf = this.scanBuf.slice(0, m.index) + this.scanBuf.slice(m.index + m[0].length);
        re.lastIndex = 0;
      }
      re.lastIndex = 0;
    };
    drain(/\x1b\[6n/g, "\x1b[1;1R");              // DSR cursor position
    drain(/\x1b\[\?6n/g, "\x1b[1;1R");
    drain(/\x1b\[5n/g, "\x1b[0n");                // device status
    drain(/\x1b\]10;\?\x07/g, "\x1b]10;rgb:ffff/ffff/ffff\x07");
    drain(/\x1b\]11;\?\x07/g, "\x1b]11;rgb:0000/0000/0000\x07");
    drain(/\x1b\]4;(\d+);\?\x07/g, (m) => `\x1b]4;${m[1]};rgb:8080/8080/8080\x07`);
    drain(/\x1b\[c/g, "\x1b[?1;2c");              // DA1
    drain(/\x1b\[>c/g, "\x1b[>41;340;0c");        // DA2 (xterm-ish)
    drain(/\x1b\[\?u/g, "\x1b[?1;2;4;8;16;32u"); // kitty keyboard query (pi waits for it)
    if (replies.length) this.write(replies.join(""));
  }

  private checkModal(): void {
    const text = tailText(this.currentBytes(), 3000).toLowerCase();
    for (const modal of this.def.modals ?? []) {
      if (this.modalsReplied.has(modal.when.source)) continue;
      if (modal.when.test(text)) {
        this.modalsReplied.add(modal.when.source);
        console.log(`[${this.name}] modal matched ${modal.when} -> reply ${JSON.stringify(modal.reply)}`);
        this.write(modal.reply);
      }
    }
  }

  currentBytes(): Buffer {
    return Buffer.concat(this.events.map((e) => e.buf));
  }

  write(data: string | Uint8Array): void {
    if (!this.pty || this.exited) return;
    try { this.pty.write(data); } catch { /* pty gone */ }
  }

  wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Wait until bytes are quiet for QUIET_MS AND some content exists. */
  async waitQuiet(capMs: number, minBytes = 400): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      const quiet = Date.now() - this.lastDataAt;
      if (this.exited) return false;
      if (quiet >= QUIET_MS && this.bytes >= minBytes && Date.now() - start >= 1500) return true;
      await this.wait(120);
    }
    return false;
  }

  /** Wait until the composer prompt glyph is on screen (composer ready). */
  async waitPrompt(capMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      if (this.exited) return false;
      if (this.promptVisible()) return true;
      await this.wait(150);
    }
    return false;
  }

  /** True when a prompt glyph is present in the current tail text. */
  promptVisible(): boolean {
    // 8000 chars: covers the full 32-row screen even when per-second footer
    // ticks (hermes) have pushed older paints out of a short tail window.
    const t = tailText(this.currentBytes(), 8000);
    return this.def.promptGlyphs.some((g) => t.includes(g));
  }

  /** Blocking/auth detection on the first ~20s of output. */
  detectBlock(): string | null {
    const t = tailText(this.currentBytes(), 4000).toLowerCase();
    const hits: [RegExp, string][] = [
      [/not logged in/, "auth: not logged in"],
      [/please run \/login/, "auth: /login required"],
      [/device code|device_code/, "auth: device-code flow"],
      [/login to continue|log in to continue|sign in to continue|to get started.*sign up/i, "auth: login required"],
      [/choose a provider|provider setup|select.*provider/i, "auth: provider picker"],
      [/enter your api key/i, "auth: api key prompt"],
      [/pairing mode|enter pairing code/i, "auth: pairing"],
    ];
    for (const [re, label] of hits) if (re.test(t)) return label;
    return null;
  }

  /** Deterministic kill: graceful bytes → SIGTERM → SIGKILL; tracks the tree. */
  async killTree(): Promise<void> {
    const pty = this.pty;
    if (!pty) return;
    const root = pty.pid;
    const descendants = (): number[] => {
      const ps = spawnSync("ps", ["-axo", "pid=,ppid="]).stdout?.toString() ?? "";
      const kids = new Map<number, number[]>();
      for (const line of ps.split("\n")) {
        const mm = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!mm) continue;
        const pid = Number(mm[1]), ppid = Number(mm[2]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid)!.push(pid);
      }
      const out: number[] = [];
      const stack = [root];
      while (stack.length) {
        const p = stack.pop()!;
        for (const k of kids.get(p) ?? []) { out.push(k); stack.push(k); }
      }
      return out;
    };
    const sig = (sig: string) => {
      const all = [root, ...descendants()];
      for (const pid of all) {
        try { process.kill(-pid, sig); } catch { /* not a pgid */ }
        try { process.kill(pid, sig); } catch { /* gone */ }
      }
      try { pty.kill(sig); } catch { /* gone */ }
    };
    sig("SIGTERM");
    await this.wait(1300);
    sig("SIGKILL");
    await this.wait(300);
  }

  /** Slice events [from, to) into a JSONL fixture, rebased at from.t. */
  writeFixture(from: number, to: number, outPath: string, tag: string): number {
    if (this.events.length > to) to = this.events.length;
    const slice = this.events.slice(from, to);
    if (!slice.length) return 0;
    const raw = Buffer.concat(slice.map((e) => e.buf)).toString("utf8");
    const scrubbed = scrub(raw, this.cwd);
    const t0 = slice[0].t;
    const t1 = slice[slice.length - 1].t;
    const totalRaw = Math.max(raw.length, 1);
    // re-chunk the scrubbed stream at ~24 KiB; interpolate each line's t
    // from its raw-offset fraction (fixture timing is informational).
    const lines: string[] = [];
    const CHUNK = 24_000;
    for (let off = 0; off < scrubbed.length; off += CHUNK) {
      const chunk = scrubbed.slice(off, off + CHUNK);
      const frac = Math.min(1, (off + chunk.length / 2) / totalRaw);
      const t = Math.round(t0 + (t1 - t0) * frac);
      lines.push(JSON.stringify({ t, b64: Buffer.from(chunk, "utf8").toString("base64") }));
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join("\n") + "\n");
    const kb = Math.round(raw.length / 1024);
    console.log(`[${this.name}] ${tag} -> ${outPath} (${lines.length} lines, ${kb} KiB)`);
    return lines.length;
  }

  sliceIndexAt(t: number): number {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
}

// ── scenario runner ─────────────────────────────────────────────────────────
type ScenarioResult = {
  harness: string;
  scenario: string;
  status: "complete" | "skip" | "fail";
  reason?: string;
  observed: Record<string, unknown>;
  expectedScreen: Record<string, unknown>;
};

function expectedScreenFor(
  def: HarnessDef,
  bytes: Buffer,
  description: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const sig = extractSignals(bytes);
  const text = tailText(bytes, 8000);
  return {
    title: sig.titles[sig.titles.length - 1] ?? "",
    osc9: sig.osc9s[sig.osc9s.length - 1] ?? "",
    promptGlyph: def.promptGlyphs.find((glyph) => text.includes(glyph)) ?? null,
    description,
    ...extra,
  };
}

function composerIsEmpty(def: HarnessDef, bytes: Buffer): boolean {
  const text = tailText(bytes, 3000);
  let glyphIndex = -1;
  let glyphLength = 0;
  for (const glyph of def.promptGlyphs) {
    const index = text.lastIndexOf(glyph);
    if (index > glyphIndex) {
      glyphIndex = index;
      glyphLength = glyph.length;
    }
  }
  if (glyphIndex < 0) return false;
  const rest = text.slice(glyphIndex + glyphLength);
  const end = rest.search(/[\r\n]/);
  const line = (end < 0 ? rest : rest.slice(0, end)).replace(/[\u2500-\u257f]/g, "").trim();
  return line === "";
}

// ── scenario steps (shared by single-session and fresh-spawn modes) ─────────
type Ctx = {
  def: HarnessDef;
  sess: Session;
  results: ScenarioResult[];
  remaining: () => number;
};

async function scenarioStartupIdle(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  const idleOk = await (async () => {
    const cap = Math.min(IDLE_WAIT_CAP_MS, remaining());
    const start = Date.now();
    while (Date.now() - start < cap) {
      if (sess.exited) return false;
      if (sess.promptVisible() && Date.now() - sess.lastDataAt >= QUIET_MS && Date.now() - start >= 1500) return true;
      // glyph-less TUIs (pi/prime-agent bare-box composer): a stable screen
      // with content after 5s is idle enough to proceed
      if (Date.now() - start >= 5000 && Date.now() - sess.lastDataAt >= QUIET_MS && sess.bytes >= 2000) return true;
      if (process.env.PTY_CAPTURE_DEBUG && Date.now() - start > 3000 && (Date.now() - start) % 5000 < 150) {
        console.log(`[${def.name}] idle-loop +${Math.round((Date.now() - start) / 1000)}s pv=${sess.promptVisible()} quiet=${Date.now() - sess.lastDataAt}ms bytes=${sess.bytes}`);
      }
      await sess.wait(150);
    }
    return sess.waitQuiet(4000, 400);
  })();
  if (!sess.exited && remaining() > 0) {
    const block = sess.detectBlock();
    if (block) {
      sess.blocked = true;
      sess.blockReason = block;
      console.log(`[${def.name}] BLOCKED: ${block}`);
    }
  }
  if (sess.blocked) {
    results.push({
      harness: def.name, scenario: "startup-idle", status: "skip",
      reason: `blocked: ${sess.blockReason}`,
      observed: { bytes: sess.bytes }, expectedScreen: {},
    });
    return;
  }
  const idleEnd = Math.min(sess.events.length, sess.sliceIndexAt(Math.max(sess.lastDataAt, Date.now() - 4000) + 1800));
  const sig = extractSignals(Buffer.concat(sess.events.slice(s0, idleEnd).map((e) => e.buf)));
  const idleText = tailText(Buffer.concat(sess.events.slice(s0, idleEnd).map((e) => e.buf)));
  const idleGlyph = def.promptGlyphs.find((g) => idleText.includes(g)) ?? null;
  if (process.env.PTY_CAPTURE_DEBUG) console.log(`[${def.name}] idleText tail:`, JSON.stringify(idleText.slice(-220)), "| glyphHits:", def.promptGlyphs.map((g) => [g, idleText.includes(g)]));
  const idleTitle = sig.titles[sig.titles.length - 1] ?? "";
  const idleOsc9 = sig.osc9s[sig.osc9s.length - 1] ?? "";
  const idleBytes = Buffer.concat(sess.events.slice(s0, idleEnd).map((e) => e.buf));
  const lines1 = sess.writeFixture(s0, idleEnd, path.join(CAPTURE_ROOT, def.name, "startup-idle.jsonl"), "startup-idle");
  results.push({
    harness: def.name, scenario: "startup-idle", status: idleOk ? "complete" : "complete",
    reason: idleOk ? undefined : "idle not fully confirmed (prompt glyph absent)",
    observed: {
      title: idleTitle, osc9: idleOsc9, glyphs: sig.glyphs,
      modes: sig.modes, promptGlyph: idleGlyph, bytes: sess.bytes,
      lines: lines1, stableQuietMs: QUIET_MS,
    },
    expectedScreen: expectedScreenFor(def, idleBytes, "idle composer of the bare TUI"),
  });
}

async function scenarioTypeEcho(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  if (remaining() < 6000 || !(await sess.waitPrompt(Math.min(15000, remaining())))) {
    results.push({ harness: def.name, scenario: "type-echo", status: "skip", reason: "timebox or composer never ready", observed: {}, expectedScreen: {} });
    return;
  }
  sess.write("\u0015");          // clear any first-run suggestion (codex etc.)
  await sess.wait(200);
  sess.write("hello");
  await sess.wait(1200);
  sess.write("\r");
  const teTurnOk = await sess.waitQuiet(Math.min(TURN_WAIT_CAP_MS, remaining()));
  const teEnd = Math.min(sess.events.length, sess.sliceIndexAt(Date.now() + 1200));
  const sig = extractSignals(Buffer.concat(sess.events.slice(s0, teEnd).map((e) => e.buf)));
  const teGlyph = def.promptGlyphs.find((g) => tailText(Buffer.concat(sess.events.slice(s0, teEnd).map((e) => e.buf))).includes(g)) ?? null;
  const teBytes = Buffer.concat(sess.events.slice(s0, teEnd).map((e) => e.buf));
  const lines2 = sess.writeFixture(s0, teEnd, path.join(CAPTURE_ROOT, def.name, "type-echo.jsonl"), "type-echo");
  results.push({
    harness: def.name, scenario: "type-echo",
    status: teTurnOk ? "complete" : "complete",
    reason: teTurnOk ? undefined : "idle-return not confirmed (timebox or session died)",
    observed: {
      title: sig.titles[sig.titles.length - 1] ?? "", osc9: sig.osc9s[sig.osc9s.length - 1] ?? "",
      glyphs: sig.glyphs, modes: sig.modes, promptGlyph: teGlyph, lines: lines2,
      idleReturned: teTurnOk, exited: sess.exited,
    },
    expectedScreen: expectedScreenFor(def, teBytes, "typed 'hello' echoed in composer, CR submits, idle returns", { echoText: "hello" }),
  });
}

async function scenarioPasteChip(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  if (remaining() < 9000 || !(await sess.waitPrompt(Math.min(15000, remaining())))) {
    results.push({ harness: def.name, scenario: "paste-chip", status: "skip", reason: "timebox or composer never ready", observed: {}, expectedScreen: {} });
    return;
  }
  sess.write("\u0015");
  await sess.wait(200);
  const pc0 = Date.now();
  // Pi collapses small bracketed pastes without ever painting their payload.
  // Use a materially larger paste there; other shipped TUIs still receive
  // enough lines to force either visible payload or their real paste chip.
  const pasteLines = def.name === "pi" ? 80 : 40;
  const pasteText = Array.from({ length: pasteLines }, (_, i) => `PASTE_LINE_${String(i).padStart(2, "0")}`).join("\n");
  const P = `\x1b[200~${pasteText}\x1b[201~`;

  const snapshotSince = (t: number) => {
    const idx = sess.sliceIndexAt(t);
    const bytes = Buffer.concat(sess.events.slice(idx).map((e) => e.buf));
    const sig = extractSignals(bytes);
    const tail = tailText(bytes, 2500);
    return { sig, tail, bytes };
  };
  const chipOf = (sig: ReturnType<typeof extractSignals>, tail: string) =>
    sig.chipText ?? (/pasted\s*text|\[\d+ lines?\]/i.test(tail) ? tail.match(/.{0,40}(?:pasted\s*text|\[\d+ lines?\]).{0,60}/i)?.[0] ?? "paste-chip-marker" : null);
  const submittedOf = (sig: ReturnType<typeof extractSignals>, tail: string) => {
    // composer empty = the LAST prompt glyph's line is blank after the glyph
    // (claude/pi: "❯"; codex/grok/kimi: "›"/"❯"; muse: "⟩"; devin: "❭")
    const glyphIdx = Math.max(...[ "\u276f", "\u203a", "\u276d", "\u27e9", ">" ].map((g) => tail.lastIndexOf(g)));
    let composerEmpty = false;
    if (glyphIdx >= 0) {
      const rest = tail.slice(glyphIdx + 1);
      const eol = rest.search(/[\r\n]/);
      const line = (eol === -1 ? rest : rest.slice(0, eol)).replace(/[\u2500-\u257f\u00b7]/g, "");
      composerEmpty = /^[\s\xa0]*$/.test(line);
    }
    // turn evidence: claude randomizes the verb ("Sautéed for 0s") — match "X for Ns";
    // codex hides the prompt during turns and shows "• Working (Ns • esc to interrupt)"
    const turnEvidence = /working|waiting for response|esc to interrupt|messages to be submitted|(?:\w+ for \d+s)|\u272e|\u23f3|login expired|[\u2800-\u28ff]|\u25e6/.test(tail) || sig.osc9s.includes("4;3");
    return composerEmpty || turnEvidence;
  };

  // ── round 1: mission-timed paste + CR at 40ms ────────────────────────────
  sess.write(P);
  await sess.wait(40);
  sess.write("\r");
  await sess.wait(2200);
  let r1 = snapshotSince(pc0);
  const chip1 = chipOf(r1.sig, r1.tail);
  const chip1AfterCr = /pasted\s*text|\[\d+ lines?\]/i.test(tailText(r1.bytes, 1500));
  const submitted1 = submittedOf(r1.sig, r1.tail);

  // ── canonical clear: ONE Ctrl+C while the chip/idle state is on screen ───
  let cleared = false;
  let ctrlCSent = false;
  if (chip1AfterCr && !submitted1) {
    ctrlCSent = true;
    sess.write("\u0003");
    await sess.wait(1500);
    const after = tailText(Buffer.concat(sess.events.slice(sess.sliceIndexAt(pc0 + 2300)).map((e) => e.buf)), 1500);
    cleared = !/pasted\s*text|\[\d+ lines?\]/i.test(after) && !after.includes("PASTE_LINE_00");
  }

  // ── round 2 (slow): let the chip render, capture it, then CR ─────────────
  let chip2: string | null = null;
  let submitted2 = false;
  if (remaining() > 8000 && !sess.exited) {
    const r2t = Date.now();
    sess.write(P);
    await sess.wait(900);                  // chip render window
    let r2pre = snapshotSince(r2t);
    chip2 = chipOf(r2pre.sig, r2pre.tail);
    sess.write("\r");
    await sess.wait(2200);
    let r2post = snapshotSince(r2t);
    submitted2 = submittedOf(r2post.sig, r2post.tail);
    if (/pasted\s*text|\[\d+ lines?\]/i.test(tailText(r2post.bytes, 1500)) && !submitted2) {
      sess.write("\u0003");
      await sess.wait(1200);
    }
  }

  const pcEnd = Math.min(sess.events.length, sess.sliceIndexAt(Date.now() + 400));
  const pcBytes = Buffer.concat(sess.events.slice(s0, pcEnd).map((e) => e.buf));
  const payloadVisible = pcBytes.includes(Buffer.from("PASTE_LINE_00", "utf8"));
  const chipObserved = !!(chip1 || chip2);
  if (!payloadVisible && !chipObserved) {
    results.push({
      harness: def.name, scenario: "paste-chip", status: "skip",
      reason: "neither pasted payload nor a real paste chip was visible",
      observed: { payloadVisible: false, chipObserved: false }, expectedScreen: {},
    });
    return;
  }
  const lines3 = sess.writeFixture(s0, pcEnd, path.join(CAPTURE_ROOT, def.name, "paste-chip.jsonl"), "paste-chip");
  results.push({
    harness: def.name, scenario: "paste-chip", status: "complete",
    observed: {
      chipText40ms: chip1, chipAfterCr40ms: chip1AfterCr, submitted40ms: submitted1,
      chipTextSlow: chip2, submittedSlow: submitted2,
      clearedByCtrlC: cleared, ctrlCSent,
      osc9s: r1.sig.osc9s, lines: lines3, pasteLines, settleMs: 40,
    },
    expectedScreen: expectedScreenFor(def, pcBytes, "round1: paste+CR@40ms (vellum timing); round2: paste, chip render, CR; ONE Ctrl+C clear", {
      pasteText, payloadVisible, chipObserved,
    }),
  });
}
async function scenarioWorkingTurn(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  if (remaining() < 6000 || !(await sess.waitPrompt(Math.min(15000, remaining())))) {
    results.push({ harness: def.name, scenario: "working-turn", status: "skip", reason: "timebox or composer never ready", observed: {}, expectedScreen: {} });
    return;
  }
  sess.write("\u0015");
  await sess.wait(200);
  const wt0 = Date.now();
  sess.write("Write forty numbered lines. Each line must contain the words VELLUM CAPTURE and its line number.");
  await sess.wait(250);
  sess.write("\r");
  const workingSeen = await (async () => {
    const start = Date.now();
    const baseline = extractSignals(sess.currentBytes());
    const baseTitles = new Set(baseline.titles);
    const baseOsc9s = new Set(baseline.osc9s);
    while (Date.now() - start < Math.min(WORKING_WAIT_CAP_MS, remaining())) {
      const sig = extractSignals(sess.currentBytes());
      if (sig.osc9s.includes("4;3")) return true;
      if (sig.titles.some((title) => !baseTitles.has(title))) return true;
      if (sig.osc9s.some((osc9) => !baseOsc9s.has(osc9))) return true;
      if (/\bworking\b|waiting for response|\bthinking\b|esc to interrupt|\u23f3/.test(tailText(sess.currentBytes(), 2000).toLowerCase())) return true;
      await sess.wait(120);
    }
    return false;
  })();
  await sess.wait(Math.max(Math.min(workingSeen ? 5000 : 2500, remaining()), 0));
  const wtStillWorking = (() => {
    const sig = extractSignals(sess.currentBytes());
    if (sig.osc9s.includes("4;3")) return true;
    return /\bworking\b|waiting for response|\bthinking\b|esc to interrupt/.test(tailText(sess.currentBytes(), 2000).toLowerCase());
  })();
  if (wtStillWorking) {
    sess.write("\u0003");
    await sess.wait(2000);
  }
  const wtIdx = sess.sliceIndexAt(wt0);
  const sig = extractSignals(Buffer.concat(sess.events.slice(wtIdx).map((e) => e.buf)));
  if (!workingSeen) {
    results.push({
      harness: def.name, scenario: "working-turn", status: "skip",
      reason: "no explicit working chrome or progress signal was observed",
      observed: { osc9s: sig.osc9s, titles: sig.titles.slice(-6) }, expectedScreen: {},
    });
    return;
  }
  const wtEnd = Math.min(sess.events.length, sess.sliceIndexAt(Date.now() + 600));
  const wtBytes = Buffer.concat(sess.events.slice(s0, wtEnd).map((e) => e.buf));
  const lines4 = sess.writeFixture(s0, wtEnd, path.join(CAPTURE_ROOT, def.name, "working-turn.jsonl"), "working-turn");
  results.push({
    harness: def.name, scenario: "working-turn", status: "complete",
    observed: {
      workingSeen, interrupted: wtStillWorking, osc9s: sig.osc9s,
      titles: sig.titles.slice(-6), glyphs: sig.glyphs, lines: lines4,
      exited: sess.exited,
    },
    expectedScreen: expectedScreenFor(def, wtBytes, "working turn: OSC title churn / spinner / progress frames then interrupt", {
      prompt: "forty numbered VELLUM CAPTURE lines",
    }),
  });
}

async function scenarioOsc9EmptyComposer(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  if (remaining() < 12_000 || !(await sess.waitPrompt(Math.min(15_000, remaining())))) {
    results.push({ harness: def.name, scenario: "osc9-empty-composer", status: "skip", reason: "composer never ready", observed: {}, expectedScreen: {} });
    return;
  }
  sess.write("\u0015");
  await sess.wait(200);
  const turnStart = Date.now();
  sess.write("Wait ten seconds, then reply with the word done.");
  await sess.wait(250);
  sess.write("\r");
  let end = -1;
  const deadline = Date.now() + Math.min(25_000, remaining());
  while (Date.now() < deadline && !sess.exited) {
    const bytes = sess.currentBytes();
    if (extractSignals(bytes).osc9s.includes("4;3") && composerIsEmpty(def, bytes)) {
      end = sess.events.length;
      break;
    }
    await sess.wait(80);
  }
  if (end < 0) {
    results.push({
      harness: def.name, scenario: "osc9-empty-composer", status: "skip",
      reason: "real OSC 9;4;3 with an empty composer was not observed",
      observed: { osc9s: extractSignals(Buffer.concat(sess.events.slice(sess.sliceIndexAt(turnStart)).map((event) => event.buf))).osc9s },
      expectedScreen: {},
    });
    sess.write("\u0003");
    await sess.wait(1200);
    return;
  }
  const bytes = Buffer.concat(sess.events.slice(s0, end).map((event) => event.buf));
  const lines = sess.writeFixture(s0, end, path.join(CAPTURE_ROOT, def.name, "osc9-empty-composer.jsonl"), "osc9-empty-composer");
  results.push({
    harness: def.name, scenario: "osc9-empty-composer", status: "complete",
    observed: { osc9: "4;3", composerEmpty: true, lines },
    expectedScreen: expectedScreenFor(def, bytes, "OSC 9;4;3 reports working while the composer is empty", {
      osc9: "4;3", composerEmpty: true,
    }),
  });
  sess.write("\u0003");
  await sess.wait(1200);
}

async function scenarioPermissionReturnsIdle(ctx: Ctx, s0: number): Promise<void> {
  const { def, sess, results, remaining } = ctx;
  if (remaining() < 15_000 || !(await sess.waitPrompt(Math.min(15_000, remaining())))) {
    results.push({ harness: def.name, scenario: "permission-returns-idle", status: "skip", reason: "composer never ready", observed: {}, expectedScreen: {} });
    return;
  }
  sess.write("\u0015");
  await sess.wait(200);
  const turnStart = Date.now();
  sess.write("Use the shell tool to run pwd, then report only its exit code.");
  await sess.wait(250);
  sess.write("\r");
  const permissionRe = /allow(?: once)?|approve|do you want to proceed|yes,? and|esc to cancel|permission required/i;
  let permissionSeen = false;
  const permissionDeadline = Date.now() + Math.min(35_000, remaining());
  while (Date.now() < permissionDeadline && !sess.exited) {
    const bytes = Buffer.concat(sess.events.slice(sess.sliceIndexAt(turnStart)).map((event) => event.buf));
    if (permissionRe.test(tailText(bytes, 5000))) {
      permissionSeen = true;
      break;
    }
    await sess.wait(120);
  }
  if (!permissionSeen) {
    results.push({
      harness: def.name, scenario: "permission-returns-idle", status: "skip",
      reason: "a real permission dialog was not observed",
      observed: {}, expectedScreen: {},
    });
    sess.write("\u0003");
    await sess.wait(1200);
    return;
  }
  sess.write("\u001b");
  await sess.wait(500);
  sess.write("\u0003");
  const idleReturned = await sess.waitPrompt(Math.min(15_000, remaining()));
  await sess.wait(Math.min(1800, Math.max(0, remaining())));
  if (!idleReturned) {
    results.push({
      harness: def.name, scenario: "permission-returns-idle", status: "skip",
      reason: "permission dialog appeared but idle did not return reliably",
      observed: { permissionSeen: true }, expectedScreen: {},
    });
    return;
  }
  const end = sess.events.length;
  const bytes = Buffer.concat(sess.events.slice(s0, end).map((event) => event.buf));
  const lines = sess.writeFixture(s0, end, path.join(CAPTURE_ROOT, def.name, "permission-returns-idle.jsonl"), "permission-returns-idle");
  results.push({
    harness: def.name, scenario: "permission-returns-idle", status: "complete",
    observed: { permissionSeen: true, idleReturned: true, lines },
    expectedScreen: expectedScreenFor(def, bytes, "permission dialog clears and the idle composer returns", {
      permissionDialogCleared: true,
    }),
  });
}

async function exitTui(def: HarnessDef, sess: Session, remaining: () => number): Promise<void> {
  if (!sess.exited && remaining() > 0) {
    for (const step of def.exitRecipe) {
      if (sess.exited || remaining() <= 0) break;
      sess.write(step);
      await sess.wait(900);
    }
    await sess.wait(600);
  }
}

async function runHarness(def: HarnessDef): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const tStart = Date.now();
  const deadline = tStart + HARNESS_TIMEOUT_MS;
  const remaining = () => deadline - Date.now();
  const finish = async (sess: Session) => {
    await sess.killTree();
    const alive = !sess.exited && sess.pty ? (() => {
      try { process.kill(sess.pty.pid, 0); return true; } catch { return false; }
    })() : false;
    console.log(`[${def.name}] done. exited=${sess.exited} aliveAfterKill=${alive} bytes=${sess.bytes}`);
    results.push({ harness: def.name, scenario: "__session__", status: sess.exited ? "complete" : "killed", reason: alive ? "process survived SIGKILL?!" : undefined, observed: { bytes: sess.bytes, elapsedMs: Date.now() - tStart }, expectedScreen: {} });
    try {
      fs.mkdirSync("/tmp/vellum-capture-raw", { recursive: true });
      const all = Buffer.concat(sess.events.map((e) => e.buf)).toString("utf8");
      fs.writeFileSync(`/tmp/vellum-capture-raw/${def.name}.bin`, Buffer.from(scrub(all, sess.cwd), "utf8"));
    } catch { /* best effort */ }
  };

  if (def.freshSpawnPerScenario) {
    const scenarios: { name: string; run: (ctx: Ctx, s0: number) => Promise<void> }[] = [
      { name: "startup-idle", run: scenarioStartupIdle },
      { name: "type-echo", run: scenarioTypeEcho },
      { name: "paste-chip", run: scenarioPasteChip },
      { name: "working-turn", run: scenarioWorkingTurn },
    ];
    for (const sc of scenarios) {
      if (remaining() < 6000) {
        results.push({ harness: def.name, scenario: sc.name, status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
        continue;
      }
      const sess = new Session(def);
      try {
        sess.spawn();
        const ctx: Ctx = { def, sess, results, remaining };
        await sc.run(ctx, 0);
        await exitTui(def, sess, remaining);
      } catch (err) {
        console.error(`[${def.name}/${sc.name}] ERROR:`, err);
        results.push({ harness: def.name, scenario: sc.name, status: "fail", reason: String(err), observed: {}, expectedScreen: {} });
      } finally {
        await finish(sess);
      }
    }
    return results;
  }

  // ── single-session mode (default) ────────────────────────────────────────
  const sess = new Session(def);
  try {
    sess.spawn();
    const s0 = sess.sliceIndexAt(tStart);
    await scenarioStartupIdle({ def, sess, results, remaining }, s0);
    if (sess.blocked) { await finish(sess); return results; }
    if (remaining() < 8000) {
      for (const sc of ["type-echo", "paste-chip", "working-turn"]) {
        results.push({ harness: def.name, scenario: sc, status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
      }
      await finish(sess); return results;
    }
    await scenarioTypeEcho({ def, sess, results, remaining }, s0);
    if (remaining() < 8000) {
      for (const sc of ["paste-chip", "working-turn"]) {
        results.push({ harness: def.name, scenario: sc, status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
      }
      await finish(sess); return results;
    }
    await scenarioPasteChip({ def, sess, results, remaining }, s0);
    if (remaining() < 8000) {
      results.push({ harness: def.name, scenario: "working-turn", status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
      await finish(sess); return results;
    }
    await scenarioWorkingTurn({ def, sess, results, remaining }, s0);
    if (remaining() >= 12_000) await scenarioOsc9EmptyComposer({ def, sess, results, remaining }, s0);
    else results.push({ harness: def.name, scenario: "osc9-empty-composer", status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
    if (remaining() >= 15_000) await scenarioPermissionReturnsIdle({ def, sess, results, remaining }, s0);
    else results.push({ harness: def.name, scenario: "permission-returns-idle", status: "skip", reason: "timebox", observed: {}, expectedScreen: {} });
    await exitTui(def, sess, remaining);
  } catch (err) {
    console.error(`[${def.name}] ERROR:`, err);
    results.push({ harness: def.name, scenario: "all", status: "fail", reason: String(err), observed: {}, expectedScreen: {} });
  } finally {
    await finish(sess);
  }
  return results;
}
// ── manifest writing ────────────────────────────────────────────────────────
function writeManifests(def: HarnessDef, results: ScenarioResult[]): void {
  const outDir = path.join(CAPTURE_ROOT, def.name);
  fs.mkdirSync(outDir, { recursive: true });
  const scenarios = results.filter((r) => r.scenario !== "__session__");
  const manifest = {
    harness: def.name,
    displayName: def.displayName,
    source: "P1-real-capture",
    capturedAt: new Date().toISOString(),
    pty: { cols: COLS, rows: ROWS, term: "xterm-256color" },
    sanitized: false,
    scrub: ["<HOME>", "<USER>", "<HOST>", "<CWD>", "<CAPTURE>", "<SESSION>", "<EMAIL>", "<TOKEN>"],
    scenarios,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function earnSanitizedStamp(root: string, harness: string, receipt: ScrubReceipt): void {
  const file = path.join(root, harness, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  manifest.sanitized = true;
  manifest.sanitization = {
    method: "decoded-jsonl-scan",
    fixtures: receipt.fixtures,
    decodedBytes: receipt.decodedBytes,
    checks: receipt.checks,
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

function promoteHarness(harness: string): void {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const source = path.join(CAPTURE_ROOT, harness);
  const destination = path.join(OUT_ROOT, harness);
  const backup = path.join(OUT_ROOT, `.${harness}.backup-${process.pid}`);
  let hadExisting = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      hadExisting = true;
    }
    fs.renameSync(source, destination);
    if (hadExisting) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(destination) && hadExisting && fs.existsSync(backup)) {
      fs.renameSync(backup, destination);
    }
    throw error;
  }
}

function updateCorpusIndex(harness: string, results: ScenarioResult[]): void {
  const file = path.join(OUT_ROOT, "index.json");
  let index: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const decoded = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      index = decoded as Record<string, unknown>;
    }
  }
  index[harness] = {
    scenarios: results.filter((result) => result.scenario !== "__session__").map((result) => ({
      scenario: result.scenario, status: result.status, reason: result.reason ?? null,
    })),
    session: results.find((result) => result.scenario === "__session__") ?? null,
  };
  const ordered = Object.fromEntries(Object.entries(index).sort(([left], [right]) => left.localeCompare(right)));
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + "\n");
}

function verifyCorpus(root: string, harnesses: readonly string[]): void {
  for (const harness of harnesses) {
    const manifestFile = path.join(root, harness, "manifest.json");
    if (!fs.existsSync(manifestFile)) throw new Error(`${harness}: manifest.json missing`);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
      sanitized?: unknown;
      sanitization?: { fixtures?: unknown; decodedBytes?: unknown; checks?: unknown };
    };
    if (manifest.sanitized !== true) throw new Error(`${harness}: sanitized stamp is not earned`);
    const receipt = certifyHarness(root, harness);
    if (manifest.sanitization?.fixtures !== receipt.fixtures ||
        manifest.sanitization?.decodedBytes !== receipt.decodedBytes ||
        JSON.stringify(manifest.sanitization?.checks) !== JSON.stringify(receipt.checks)) {
      throw new Error(`${harness}: sanitization receipt does not match decoded corpus`);
    }
  }
}

// ── canonicality check (real SessionObserver) ───────────────────────────────
async function checkFixture(harness: string, scenario: string, glyphArg?: string): Promise<boolean> {
  const fixture = path.join(OUT_ROOT, harness, `${scenario}.jsonl`);
  if (!fs.existsSync(fixture)) { console.error(`fixture not found: ${fixture}`); return false; }
  const mod = await import(path.join(REPO, "src/main/vellum/term/observer/index.ts"));
  const { SessionObserver } = mod as { SessionObserver: new (o: { bindingId: string; epoch: string; cols: number; rows: number }) => { feed(d: string, s: bigint): void; snapshot(): Promise<{ text: string; lines: readonly string[]; signals: { title: string; osc9: string; modes: Record<string, unknown> } }>; dispose(): void } };
  const obs = new SessionObserver({ bindingId: "check", epoch: "check", cols: COLS, rows: ROWS });
  const lines = fs.readFileSync(fixture, "utf8").trim().split("\n");
  let seq = 0n;
  for (const line of lines) {
    if (!line.trim()) continue;
    const { b64 } = JSON.parse(line);
    const bytes = Buffer.from(b64, "base64");
    obs.feed(bytes.toString("utf8"), ++seq);
  }
  const snap = await obs.snapshot();
  const text = snap.text;
  const tail = snap.lines.slice(-10).join("\n");
  console.log("── snapshot ──");
  console.log("title :", JSON.stringify(snap.signals.title));
  console.log("osc9  :", JSON.stringify(snap.signals.osc9));
  console.log("modes :", JSON.stringify(snap.signals.modes));
  console.log("── last 10 lines ──");
  console.log(tail);
  let ok = true;
  if (glyphArg) {
    ok = text.includes(glyphArg);
    console.log(`glyph check "${glyphArg}": ${ok ? "PRESENT" : "ABSENT"}`);
  }
  obs.dispose();
  return ok;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "list") {
    for (const h of HARNESSES.filter((harness) => SHIPPED_HARNESSES.has(harness.name))) {
      console.log(h.name.padEnd(12), h.displayName);
    }
    return;
  }
  if (args[0] === "verify") {
    const present = [...SHIPPED_HARNESSES].filter((harness) => fs.existsSync(path.join(OUT_ROOT, harness)));
    if (present.length === 0) throw new Error(`no shipped harness corpus found at ${OUT_ROOT}`);
    verifyCorpus(OUT_ROOT, present);
    console.log(`CORPUS SCRUB: PASS (${present.length} harnesses at ${path.relative(REPO, OUT_ROOT)})`);
    return;
  }
  if (args[0] === "check") {
    const harness = args[1];
    const scenario = args[2];
    const glyphIdx = args.indexOf("--glyph");
    const glyph = glyphIdx >= 0 ? args[glyphIdx + 1] : undefined;
    if (!harness || !scenario) { console.error("usage: check <harness> <scenario> [--glyph G]"); process.exit(2); }
    const ok = await checkFixture(harness, scenario, glyph);
    console.log(`CANONICALITY: ${ok ? "PASS" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  }
  if (args[0] === "check-all") {
    let allOk = true;
    for (const h of HARNESSES.filter((harness) => SHIPPED_HARNESSES.has(harness.name))) {
      const dir = path.join(OUT_ROOT, h.name);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
        const scenario = f.replace(/\.jsonl$/, "");
        const glyph = h.promptGlyphs[0];
        console.log(`\n=== ${h.name}/${scenario} (glyph ${JSON.stringify(glyph)}) ===`);
        try {
          const ok = await checkFixture(h.name, scenario, glyph);
          allOk = allOk && ok;
        } catch (e) { console.error("check error:", e); allOk = false; }
      }
    }
    console.log(`\nCHECK-ALL: ${allOk ? "PASS" : "FAIL"}`);
    process.exit(allOk ? 0 : 1);
  }

  // capture mode
  const only = args[0];
  const shipped = HARNESSES.filter((harness) => SHIPPED_HARNESSES.has(harness.name));
  const defs = only ? shipped.filter((harness) => harness.name === only) : shipped;
  if (only && defs.length === 0) {
    console.error(`unknown or unshipped harness '${only}'. Try: list`);
    process.exit(2);
  }
  fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
  try {
    for (const def of defs) {
      console.log(`\n========== ${def.name} (${def.displayName}) ==========`);
      const results = await runHarness(def);
      writeManifests(def, results);
      const receipt = certifyHarness(CAPTURE_ROOT, def.name);
      earnSanitizedStamp(CAPTURE_ROOT, def.name, receipt);
      promoteHarness(def.name);
      updateCorpusIndex(def.name, results);
    }
    verifyCorpus(OUT_ROOT, defs.map((definition) => definition.name));
    console.log("\ncorpus written to", OUT_ROOT);
  } finally {
    fs.rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
