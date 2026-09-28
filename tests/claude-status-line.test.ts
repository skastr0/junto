import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTokenPressure, type SeatPressureSnapshot } from "../src/shared/token-pressure";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import {
  buildClaudeStatusSettings,
  CLAUDE_STATUS_RECORDER_SCRIPT,
  claudeStatusPaths,
  parseClaudeStatusRecord,
  userStatusLine,
  writeClaudeStatusSettings,
} from "../src/main/junto/term/claude-status-line";
import { encodeClaudeProjectCwd } from "../src/main/junto/term/session-existence";
import { contextReaderFor, withLiveWindow } from "../src/main/junto/token-pressure/readers";
import { SessionTail } from "../src/main/junto/token-pressure/session-tail";
import { TokenPressureMonitor, type PressureSeat } from "../src/main/junto/token-pressure/monitor";

// A real status line payload from Claude Code 2.1.284 (Haiku 4.5, second
// turn), captured through this recorder's chain; ids, paths, and names
// replaced. Its session id is the one the Claude transcript fixture uses.
const FIXTURES = join(__dirname, "fixtures", "token-pressure");
const PAYLOAD = readFileSync(join(FIXTURES, "claude-statusline.json"), "utf8");
const SESSION = "11111111-2222-4333-8444-555555555555";
const CWD = "/work/fixture";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "junto-claude-status-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const recorder = (): string => {
  const path = join(dir, "recorder.sh");
  writeFileSync(path, CLAUDE_STATUS_RECORDER_SCRIPT, { mode: 0o700 });
  return path;
};

const run = (command: string, args: readonly string[], stdin: string) =>
  spawnSync(command, args, { input: stdin, encoding: "utf8", cwd: dir });

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("status line recorder", () => {
  it("records the harness's own window, percent, and input from a real payload, owner-only", () => {
    const record = join(dir, "seat.json");
    const result = run(recorder(), [record], PAYLOAD);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const row = JSON.parse(readFileSync(record, "utf8")) as Record<string, unknown>;
    expect(Object.keys(row)).toEqual(["session_id", "context_window_size", "used_percentage", "total_input_tokens", "at"]);
    // rate_limits carries used_percentage 9 and 82: only the context's counts.
    expect(row).toMatchObject({
      session_id: SESSION,
      context_window_size: 200_000,
      used_percentage: 17,
      total_input_tokens: 34_263,
    });
    expect(Math.abs((row.at as number) - Date.now() / 1000)).toBeLessThan(60);
    expect(mode(record)).toBe(0o600);
    expect(parseClaudeStatusRecord(readFileSync(record, "utf8"))).toMatchObject({
      sessionId: SESSION,
      contextWindowSize: 200_000,
      usedPercentage: 17,
      totalInputTokens: 34_263,
    });
  });

  it("keeps the window when the percentage is null, as right after /compact", () => {
    const payload = JSON.parse(PAYLOAD) as { context_window: Record<string, unknown> };
    payload.context_window.used_percentage = null;
    payload.context_window.current_usage = null;
    const record = join(dir, "seat.json");
    run(recorder(), [record], JSON.stringify(payload, null, 2));
    const parsed = parseClaudeStatusRecord(readFileSync(record, "utf8"));
    expect(parsed).toMatchObject({ sessionId: SESSION, contextWindowSize: 200_000 });
    expect(parsed?.usedPercentage).toBeUndefined();
  });

  it("writes nothing for a payload without a window, and leaves no temp file", () => {
    const record = join(dir, "seat.json");
    writeFileSync(record, "previous");
    const result = run(recorder(), [record], JSON.stringify({ session_id: SESSION }));
    expect(result.status).toBe(0);
    expect(readFileSync(record, "utf8")).toBe("previous");
    expect(readdirSync(dir).sort()).toEqual(["recorder.sh", "seat.json"]);
  });

  it("prints the operator's own status line unchanged, fed the same payload", () => {
    const user = join(dir, "user.sh");
    // Echoes stdin's session id and model, with colour, over two lines.
    writeFileSync(
      user,
      `input=$(cat)\nprintf '\\033[32m%s\\033[0m\\n' "$(printf '%s' "$input" | grep -o '"display_name":"[^"]*"')"\necho "second line"\n`,
    );
    const chain = join(dir, "chain.sh");
    writeFileSync(chain, `sh '${user}'\n`);
    const direct = run("/bin/sh", [user], PAYLOAD);
    const chained = run(recorder(), [join(dir, "seat.json"), chain], PAYLOAD);
    expect(direct.stdout).toBe('\u001b[32m"display_name":"Haiku 4.5"\u001b[0m\nsecond line\n');
    expect(chained.stdout).toBe(direct.stdout);
    expect(chained.status).toBe(0);
    expect(existsSync(join(dir, "seat.json"))).toBe(true);
  });

  it("prints nothing when the operator has no status line", () => {
    expect(run(recorder(), [join(dir, "seat.json")], PAYLOAD).stdout).toBe("");
  });
});

describe("seat settings", () => {
  const settingsAt = (path: string, statusLine: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ statusLine }));
  };

  it("takes the operator's status line from local, then project, then user settings, keeping its layout keys", () => {
    const project = join(dir, "project");
    const config = join(dir, "config");
    settingsAt(join(config, "settings.json"), { type: "command", command: "user-line", padding: 1 });
    expect(userStatusLine({ cwd: project, configDir: config })).toEqual({ command: "user-line", extras: { padding: 1 } });
    settingsAt(join(project, ".claude", "settings.json"), { type: "command", command: "project-line" });
    expect(userStatusLine({ cwd: project, configDir: config })?.command).toBe("project-line");
    settingsAt(join(project, ".claude", "settings.local.json"), { type: "command", command: "local-line", refreshInterval: 5 });
    expect(userStatusLine({ cwd: project, configDir: config })).toEqual({
      command: "local-line",
      extras: { refreshInterval: 5 },
    });
    expect(userStatusLine({ cwd: join(dir, "elsewhere"), configDir: join(dir, "none") })).toBeUndefined();
  });

  it("chains only when the operator has a line", () => {
    const paths = claudeStatusPaths("agent-1", dir)!;
    expect(buildClaudeStatusSettings(paths, undefined).statusLine.command).toBe(`'${paths.recorder}' '${paths.record}'`);
    expect(buildClaudeStatusSettings(paths, { command: "x", extras: { padding: 2 } }).statusLine).toEqual({
      padding: 2,
      type: "command",
      command: `'${paths.recorder}' '${paths.record}' '${paths.chain}'`,
    });
  });

  it("writes owner-only files whose command records and still shows the operator's line", () => {
    const config = join(dir, "config");
    const home = join(dir, "junto home's");
    settingsAt(join(config, "settings.json"), { type: "command", command: "echo \"operator: $(cat | wc -c | tr -d ' ')\"" });
    const path = writeClaudeStatusSettings({ seatRef: "agent-01", cwd: join(dir, "project"), configDir: config, home })!;
    const paths = claudeStatusPaths("agent-01", home)!;
    expect(path).toBe(paths.settings);
    expect(mode(join(paths.recorder, ".."))).toBe(0o700);
    expect(mode(paths.recorder)).toBe(0o700);
    expect(mode(paths.settings)).toBe(0o600);
    expect(mode(paths.chain)).toBe(0o600);
    const { statusLine } = JSON.parse(readFileSync(path, "utf8")) as { statusLine: { command: string } };
    // How Claude runs it: the command string through a shell, payload on stdin.
    const shown = run("/bin/sh", ["-c", statusLine.command], PAYLOAD);
    // The payload arrives whole, ending in one newline.
    expect(shown.stdout).toBe(`operator: ${PAYLOAD.trimEnd().length + 1}\n`);
    expect(parseClaudeStatusRecord(readFileSync(paths.record, "utf8"))?.contextWindowSize).toBe(200_000);
  });

  it("rides every Claude launch, resume included", () => {
    const fresh = resolveManagedLaunch("claude", { sessionId: SESSION, settingsFile: "/s.json" });
    const resumed = resolveManagedLaunch("claude", { resumeId: SESSION, settingsFile: "/s.json" });
    for (const launch of [fresh, resumed]) {
      const argv = launch.argv ?? [];
      expect(argv[argv.indexOf("--settings") + 1]).toBe("/s.json");
    }
    expect(resolveManagedLaunch("codex", { settingsFile: "/s.json" }).argv).not.toContain("--settings");
  });
});

describe("Claude context reading", () => {
  const placeTranscript = (home: string): void => {
    const projects = join(home, ".claude", "projects", encodeClaudeProjectCwd(CWD));
    mkdirSync(projects, { recursive: true });
    copyFileSync(join(FIXTURES, "claude-session.jsonl"), join(projects, `${SESSION}.jsonl`));
  };

  const placeRecord = (juntoHome: string, payload: string = PAYLOAD): void => {
    const paths = claudeStatusPaths("seat-1", juntoHome)!;
    mkdirSync(join(paths.record, ".."), { recursive: true });
    const script = join(dir, "recorder.sh");
    writeFileSync(script, CLAUDE_STATUS_RECORDER_SCRIPT, { mode: 0o700 });
    expect(run(script, [paths.record], payload).status).toBe(0);
  };

  const read = (juntoHome: string, nodeId: string | undefined = "seat-1") => {
    const opened = contextReaderFor("claude")!.open(
      { harness: "claude", sessionId: SESSION, cwd: CWD, ...(nodeId ? { nodeId } : {}) },
      dir,
      juntoHome,
    )!;
    return withLiveWindow(new SessionTail(opened.path, opened.parse).read(), opened);
  };

  it("uses transcript usage with the window and percent Claude reported", () => {
    placeTranscript(dir);
    placeRecord(join(dir, "junto"));
    expect(read(join(dir, "junto"))).toMatchObject({
      usedTokens: 132_264,
      window: 200_000,
      windowSource: "session",
      usedPercent: 17,
    });
  });

  it("says the window is unknown before the first report, or when the report is another session's", () => {
    placeTranscript(dir);
    expect(read(join(dir, "junto"))?.window).toBeUndefined();
    placeRecord(join(dir, "junto"), PAYLOAD.replace(SESSION, "99999999-2222-4333-8444-555555555555"));
    expect(read(join(dir, "junto"))?.window).toBeUndefined();
    expect(read(join(dir, "junto"), undefined)?.window).toBeUndefined();
  });

  it("blocks a percent limit until Claude reports, then applies it to the reported window", async () => {
    placeTranscript(dir);
    const juntoHome = join(dir, "junto");
    const seat: PressureSeat = {
      canvasName: "main",
      nodeId: "seat-1",
      bindingId: "b-1",
      harness: "claude",
      sessionId: SESSION,
      cwd: CWD,
    };
    const snapshots: SeatPressureSnapshot[] = [];
    let now = 1_000;
    const monitor = new TokenPressureMonitor({
      listSeats: async () => [seat],
      isLive: () => true,
      isIdle: () => false,
      settings: () => ({ ...defaultTokenPressure(), threshold: { kind: "percent", percent: 75 } }),
      nudge: async () => true,
      publish: (change) => snapshots.push(...change.upserts),
      home: () => dir,
      juntoHome: () => juntoHome,
      now: () => now,
    });
    await monitor.tick();
    expect(snapshots.at(-1)).toMatchObject({ status: "reading", usedTokens: 132_264, limitBlocked: "no-window" });
    expect(snapshots.at(-1)?.window).toBeUndefined();
    placeRecord(juntoHome);
    now += 5_000;
    await monitor.tick();
    expect(snapshots.at(-1)).toMatchObject({
      window: 200_000,
      windowSource: "session",
      usedPercent: 17,
      limitTokens: 150_000,
      phase: "below",
    });
  });
});
