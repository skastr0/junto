import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __setSessionExistenceHomeForTest,
  encodeClaudeProjectCwd,
  encodeGrokSessionCwd,
  harnessSessionExists,
  isHarnessResumeFailureText,
  launchArgvUsesResume,
  shouldResumeHarnessSession,
} from "../src/main/vellum/term/session-existence";
import { launchForManagedSpawn } from "../src/main/vellum/term/managed-spawn-plan";
import type { CanvasDoc } from "../src/shared/canvas";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";

const temps: string[] = [];

afterEach(() => {
  // These cases assert production pin/resume semantics. The shared Vitest
  // setup deliberately enables an isolated VELLUM_COMMAND_HOME for state safety, so
  // clear it for the assertion and restore the harness after each case.
  if (originalVellumHome === undefined) delete process.env.VELLUM_COMMAND_HOME;
  else process.env.VELLUM_COMMAND_HOME = originalVellumHome;
  __setSessionExistenceHomeForTest(undefined);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const originalVellumHome = process.env.VELLUM_COMMAND_HOME;

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vellum-session-exist-"));
  temps.push(dir);
  return dir;
};

describe("harness session existence (external proof)", () => {
  it("proves grok session only when ~/.grok/sessions/<enc-cwd>/<id> exists", () => {
    const home = tempHome();
    const cwd = "/Users/me/proj";
    const sid = "eacbbdbf-e813-5648-927c-a357e5eddaad";
    expect(
      harnessSessionExists({ harness: "grok", sessionId: sid, cwd, home }),
    ).toBe(false);

    const dir = join(home, ".grok", "sessions", encodeGrokSessionCwd(cwd), sid);
    mkdirSync(dir, { recursive: true });
    expect(
      harnessSessionExists({ harness: "grok", sessionId: sid, cwd, home }),
    ).toBe(true);
    expect(
      harnessSessionExists({
        harness: "grok",
        sessionId: sid,
        home,
        // cwd omitted — still finds via one-level scan
      }),
    ).toBe(true);
  });

  it("proves claude session via project dir or jsonl", () => {
    const home = tempHome();
    const cwd = "/Users/me/proj";
    const sid = "11111111-1111-1111-1111-111111111111";
    const project = join(home, ".claude", "projects", encodeClaudeProjectCwd(cwd));
    mkdirSync(project, { recursive: true });
    expect(
      harnessSessionExists({ harness: "claude", sessionId: sid, cwd, home }),
    ).toBe(false);

    writeFileSync(join(project, `${sid}.jsonl`), "{}\n");
    expect(
      harnessSessionExists({ harness: "claude", sessionId: sid, cwd, home }),
    ).toBe(true);
  });

  it("never treats our cache/mint as proof", () => {
    expect(
      shouldResumeHarnessSession(true, {
        harness: "grok",
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        home: tempHome(),
      }),
    ).toBe(false);
    expect(
      shouldResumeHarnessSession(false, {
        harness: "grok",
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        home: tempHome(),
      }),
    ).toBe(false);
  });

  it("classifies grok remote restore 404 as resume failure", () => {
    expect(
      isHarnessResumeFailureText(
        "Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found",
      ),
    ).toBe(true);
    expect(isHarnessResumeFailureText("hello idle composer")).toBe(false);
  });

  it("detects resume argv shapes", () => {
    expect(launchArgvUsesResume(["grok", "-r", "abc"])).toBe(true);
    expect(launchArgvUsesResume(["claude", "--resume", "abc"])).toBe(true);
    expect(launchArgvUsesResume(["codex", "resume", "abc"])).toBe(true);
    expect(launchArgvUsesResume(["grok", "--session-id", "abc"])).toBe(false);
  });
  it("proves pi session when a jsonl under ~/.pi/agent/sessions contains the uuid", () => {
    const home = tempHome();
    const cwd = "/Users/me/proj";
    const sid = "019fd402-9e75-75e2-bca4-18bff1f2d5cc";
    expect(
      harnessSessionExists({ harness: "pi", sessionId: sid, cwd, home }),
    ).toBe(false);

    // Layout: ~/.pi/agent/sessions/--<cwd-dashed>--/<ISO-ts>_<uuidv7>.jsonl
    const dir = join(home, ".pi", "agent", "sessions", "--Users-me-proj--");
    mkdirSync(dir, { recursive: true });
    expect(
      harnessSessionExists({ harness: "pi", sessionId: sid, cwd, home }),
    ).toBe(false);
    writeFileSync(
      join(dir, "2026-08-05T22-19-29-269Z_" + sid + ".jsonl"),
      '{"type":"session","version":3}\n',
    );
    expect(
      harnessSessionExists({ harness: "pi", sessionId: sid, cwd, home }),
    ).toBe(true);
    // cwd omitted — one-level scan still finds the encoded dir.
    expect(
      harnessSessionExists({ harness: "pi", sessionId: sid, home }),
    ).toBe(true);
    expect(
      harnessSessionExists({ harness: "pi", sessionId: "no-such", home }),
    ).toBe(false);
  });

  it("proves prime-agent session when ~/.prime/agent/sessions/<uuid>.jsonl exists", () => {
    const home = tempHome();
    const sid = "8f3c2a1e-b4d5-4e6f-9a0b-1c2d3e4f5a6b";
    expect(
      harnessSessionExists({ harness: "prime-agent", sessionId: sid, home }),
    ).toBe(false);

    const dir = join(home, ".prime", "agent", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      '{"type":"session","version":3,"id":"' + sid + '"}\n',
    );
    expect(
      harnessSessionExists({ harness: "prime-agent", sessionId: sid, home }),
    ).toBe(true);
    expect(
      harnessSessionExists({ harness: "prime-agent", sessionId: "deadbeef", home }),
    ).toBe(false);
  });

  it("proves kimi session when ~/.kimi-code/sessions/<workDirKey>/<id>/ holds state", () => {
    const home = tempHome();
    const sid = "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc";
    expect(
      harnessSessionExists({ harness: "kimi", sessionId: sid, home }),
    ).toBe(false);

    // Layout: $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/{state.json, agents/...}
    const dir = join(home, ".kimi-code", "sessions", "wd_vellum", sid);
    mkdirSync(join(dir, "agents", "main"), { recursive: true });
    writeFileSync(join(dir, "state.json"), "{}");
    writeFileSync(join(dir, "agents", "main", "wire.jsonl"), "");
    expect(
      harnessSessionExists({ harness: "kimi", sessionId: sid, home }),
    ).toBe(true);
    expect(
      harnessSessionExists({ harness: "kimi", sessionId: "ses_00000000", home }),
    ).toBe(false);
  });

  it("proves muse session when ~/.local/share/muse/sessions/<date>/<uuid>/session.jsonl exists", () => {
    const home = tempHome();
    const sid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    expect(
      harnessSessionExists({ harness: "muse", sessionId: sid, home }),
    ).toBe(false);

    // Layout: ~/.local/share/muse/sessions/<yyyy>/<mm>/<dd>/<uuid>/session.jsonl.
    // The session dir itself is the proof (bounded walk matches the uuid dir
    // name), so the first true assertion is after mkdir, not after the file.
    const dir = join(
      home,
      ".local",
      "share",
      "muse",
      "sessions",
      "2026",
      "08",
      "06",
      sid,
    );
    expect(
      harnessSessionExists({ harness: "muse", sessionId: sid, home }),
    ).toBe(false);
    mkdirSync(dir, { recursive: true });
    expect(
      harnessSessionExists({ harness: "muse", sessionId: sid, home }),
    ).toBe(true);
    writeFileSync(join(dir, "session.jsonl"), '{"runtime":{"session":{"metadata":{}}}}\n');
    expect(
      harnessSessionExists({ harness: "muse", sessionId: sid, home }),
    ).toBe(true);
  });

  it("proves devin session via transcript or lock under ~/.local/share/devin/cli", () => {
    const home = tempHome();
    const sid = "sample-session";
    expect(
      harnessSessionExists({ harness: "devin", sessionId: sid, home }),
    ).toBe(false);

    // Transcript: transcripts/<session-id>.json (ATIF-v1.7).
    const transcripts = join(home, ".local", "share", "devin", "cli", "transcripts");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, `${sid}.json`),
      '{"schema_version":"1.7","session_id":"' + sid + '"}\n',
    );
    expect(
      harnessSessionExists({ harness: "devin", sessionId: sid, home }),
    ).toBe(true);

    // Lock-only layout: session_locks/<session-id>.lock.
    const locks = join(home, ".local", "share", "devin", "cli", "session_locks");
    const lockId = "sample-bird";
    expect(
      harnessSessionExists({ harness: "devin", sessionId: lockId, home }),
    ).toBe(false);
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${lockId}.lock`), "60753");
    expect(
      harnessSessionExists({ harness: "devin", sessionId: lockId, home }),
    ).toBe(true);
  });

  it("honors the injectable test home override for the five probes", () => {
    const home = tempHome();
    __setSessionExistenceHomeForTest(home);
    const sid = "8f3c2a1e-b4d5-4e6f-9a0b-1c2d3e4f5a6b";
    expect(
      harnessSessionExists({ harness: "prime-agent", sessionId: sid }),
    ).toBe(false);
    const dir = join(home, ".prime", "agent", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), "");
    expect(
      harnessSessionExists({ harness: "prime-agent", sessionId: sid }),
    ).toBe(true);
  });
});

describe("spawn replan resume gate", () => {
  it("resume:true without external proof pins with --session-id", () => {
    delete process.env.VELLUM_COMMAND_HOME;
    const node = makeManagedAgentNode(0, 0, {
      harness: "grok",
      host: "local",
      cwd: "/Users/me/proj",
    });
    const sid = node.ether!.terminal!.sessionId!;
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "grok",
      documentLaunch: node.ether!.terminal!.launch,
      resume: true,
      cwd: "/Users/me/proj",
    });
    const argv = launch!.argv ?? [];
    expect(argv).toContain("--session-id");
    expect(argv).toContain(sid);
    expect(argv).not.toContain("-r");
  });

  it("resume:true with external proof uses -r", () => {
    delete process.env.VELLUM_COMMAND_HOME;
    const home = tempHome();
    const cwd = "/Users/me/proj";
    const node = makeManagedAgentNode(0, 0, {
      harness: "grok",
      host: "local",
      cwd,
    });
    const sid = node.ether!.terminal!.sessionId!;
    mkdirSync(join(home, ".grok", "sessions", encodeGrokSessionCwd(cwd), sid), {
      recursive: true,
    });
    __setSessionExistenceHomeForTest(home);
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "grok",
      documentLaunch: node.ether!.terminal!.launch,
      resume: true,
      cwd,
    });
    const argv = launch!.argv ?? [];
    expect(argv).toContain("-r");
    expect(argv).toContain(sid);
    expect(argv).not.toContain("--session-id");
  });
});
