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
  // setup deliberately enables an isolated VELLUM_HOME for state safety, so
  // clear it for the assertion and restore the harness after each case.
  if (originalVellumHome === undefined) delete process.env.VELLUM_HOME;
  else process.env.VELLUM_HOME = originalVellumHome;
  __setSessionExistenceHomeForTest(undefined);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const originalVellumHome = process.env.VELLUM_HOME;

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
});

describe("spawn replan resume gate", () => {
  it("resume:true without external proof pins with --session-id", () => {
    delete process.env.VELLUM_HOME;
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
    delete process.env.VELLUM_HOME;
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
