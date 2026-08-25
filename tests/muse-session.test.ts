import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMuseSessionId,
  isMuseSessionId,
  museSessionsRoot,
} from "../src/main/vellum/term/templates/muse-session";
import { MUSE_TEMPLATE } from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";

// Shapes below are transcribed from a real muse 0.2.1 session.jsonl.
const RECORD = (sessionId: string, workspaceRoot: string, atMs: number) =>
  JSON.stringify({
    schema_version: 1,
    id: "c08bf5a3-fbea-4cd6-b57c-a53858fa55b7",
    stream: { kind: "session", id: sessionId },
    sequence: 1,
    // muse records microseconds.
    recorded_at: atMs * 1000,
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: "runtime.session.metadata",
    payload: {
      kind: "runtime.session.metadata",
      record: {
        build: "0.2.1-R1215.1",
        provider_id: "echo",
        tool_surface_version: 1,
        web_search_mode: "off",
        workspace_root: workspaceRoot,
      },
    },
  });

let home: string | undefined;

const seedSession = (
  sessionId: string,
  workspaceRoot: string,
  atMs: number,
  day = "25",
): void => {
  const dir = join(museSessionsRoot(home!), "2026", "08", day, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.jsonl"),
    `${RECORD(sessionId, workspaceRoot, atMs)}\n`,
    "utf8",
  );
};

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-3333-4333-8333-cccccccccccc";
const WORKSPACE = "/repo/vellum";
const OTHER = "/repo/other";

describe("muse session capture", () => {
  it("claims the session started in this workspace after this seat spawned", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    seedSession(A, WORKSPACE, 1_000);
    expect(
      captureMuseSessionId({ cwd: WORKSPACE, spawnedAtMs: 900, home }),
    ).toBe(A);
  });

  it("never claims another workspace's session", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    seedSession(B, OTHER, 5_000);
    expect(
      captureMuseSessionId({ cwd: WORKSPACE, spawnedAtMs: 900, home }),
    ).toBeUndefined();
  });

  it("never claims a session that predates the seat", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    // The seat before this one, in the same workspace: the trap that a
    // newest-directory-wins capture would fall into.
    seedSession(A, WORKSPACE, 1_000);
    expect(
      captureMuseSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 60_000,
        graceMs: 0,
        home,
      }),
    ).toBeUndefined();
  });

  it("takes its own generation when a workspace has several", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    seedSession(A, WORKSPACE, 1_000);
    seedSession(B, WORKSPACE, 9_000);
    seedSession(C, OTHER, 12_000);
    expect(
      captureMuseSessionId({ cwd: WORKSPACE, spawnedAtMs: 8_000, home }),
    ).toBe(B);
  });

  it("answers undefined while muse has not written the store yet", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    expect(
      captureMuseSessionId({ cwd: WORKSPACE, spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("ignores junk in the store rather than throwing", () => {
    home = mkdtempSync(join(tmpdir(), "muse-capture-"));
    const dir = join(museSessionsRoot(home), "2026", "08", "25", A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), "not json\n", "utf8");
    // A directory whose name is not a uuid is skipped outright.
    mkdirSync(join(museSessionsRoot(home), "2026", "08", "25", "scratch"), {
      recursive: true,
    });
    expect(
      captureMuseSessionId({ cwd: WORKSPACE, spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("recognizes muse ids", () => {
    expect(isMuseSessionId(A)).toBe(true);
    expect(isMuseSessionId("T-01a03989-71a6-733b-ac4c-76f54969cb55")).toBe(false);
    expect(isMuseSessionId("")).toBe(false);
  });
});

describe("muse launch shape", () => {
  it("resumes an exact session and never opens the picker", () => {
    const resumed = resolveManagedLaunch("muse", { resumeId: A }, {});
    expect(resumed.argv).toEqual(["muse", "resume", A]);
    // Bare `muse resume` is the session picker — a seat on no known session.
    const fresh = resolveManagedLaunch("muse", {}, {});
    expect(fresh.argv).not.toContain("resume");
  });

  it("claims capture, and claims no doctrine beyond Tier B", () => {
    expect(MUSE_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(MUSE_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(MUSE_TEMPLATE.injectionSpec.flags).toEqual([]);
    expect(MUSE_TEMPLATE.capabilityBadges.instructionInjection).toBe("B");
    // --agents is an agent-definition overlay, not a system prompt: its schema
    // rejects systemPrompt and silently drops unknown keys, so nothing in the
    // template may advertise it as an injection route.
    expect(MUSE_TEMPLATE.argvSpec.agentFlag).toBeUndefined();
    expect(MUSE_TEMPLATE.argvSpec.systemPromptFlag).toBeUndefined();
  });
});
