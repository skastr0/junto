import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FX_INDEX_SCHEMA_VERSION,
  discoverFxSessionId,
  fxSessionIdCreatedAtMs,
  fxSessionsRoot,
  isFxSessionId,
} from "../src/main/junto/term/templates/fx-session";
import { parseFxModelsJson } from "../src/main/junto/term/templates/enumerate-models";
import {
  FX_TEMPLATE,
  SPAWN_ENV_SCRUB,
} from "../src/shared/managed-terminal-templates";
import {
  resolveManagedLaunch,
  stripIdlessSessionContinue,
} from "../src/shared/managed-terminal-launch";
import { evaluate } from "../src/main/junto/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";

// Ids below are real directory names from ~/.fx/sessions on the probed machine.
const A = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
const B = "1787763494998-1787763494998649000-97d25f70d04d6c5e";
const OLD = "1787249073205-1787249073205767000-7094405acf93d7c9";
// 0.0.8 shape: 12-char url-safe token (session_layout.zig generateSessionId).
const SHORT = "AbC_-0123xyz";
const WORKSPACE = "/Users/developer/Projects/vellum";
const OTHER = "/repo/other";

let home: string | undefined;

const seedIndex = (
  rows: ReadonlyArray<{ id: string; ms: number; root: string }>,
  schemaVersion = FX_INDEX_SCHEMA_VERSION,
): void => {
  const root = fxSessionsRoot(home!);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "index.json"),
    JSON.stringify({
      schema_version: schemaVersion,
      sessions: rows.map((r) => ({
        id: r.id,
        created_at_ms: r.ms,
        updated_at_ms: r.ms + 10,
        workspace_root: r.root,
        origin_workspace_root: r.root,
        history_len: 1,
      })),
    }),
    "utf8",
  );
};

const seedDirs = (ids: readonly string[]): void => {
  for (const id of ids) {
    mkdirSync(join(fxSessionsRoot(home!), id), { recursive: true });
  }
};

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("fx session ids", () => {
  it("recognizes the shape fx actually writes", () => {
    expect(isFxSessionId(A)).toBe(true);
    expect(fxSessionIdCreatedAtMs(A)).toBe(1787761861883);
    expect(isFxSessionId("index.json")).toBe(false);
    expect(isFxSessionId("1787761861883-nope-7afaf80c")).toBe(false);
    expect(fxSessionIdCreatedAtMs("not-an-id")).toBeUndefined();
  });

  it("accepts 0.0.8 12-char url-safe tokens without inventing a timestamp", () => {
    expect(isFxSessionId(SHORT)).toBe(true);
    expect(isFxSessionId("ef75d8fd94fd")).toBe(true);
    expect(fxSessionIdCreatedAtMs(SHORT)).toBeUndefined();
    expect(isFxSessionId("abcdef12345")).toBe(false);
    expect(isFxSessionId("abcdef1234567")).toBe(false);
    expect(isFxSessionId("AbC+0123xyzW")).toBe(false);
    expect(isFxSessionId("last")).toBe(false);
    expect(isFxSessionId("latest")).toBe(false);
  });
});

describe("fx session discovery", () => {
  it("claims the session this workspace started after this seat spawned", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    seedIndex([
      { id: OLD, ms: 1787249073205, root: WORKSPACE },
      { id: A, ms: 1787761861883, root: WORKSPACE },
      { id: B, ms: 1787763494998, root: OTHER },
    ]);
    expect(
      discoverFxSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 1787761861000,
        home,
      }),
    ).toBe(A);
  });

  it("never claims another workspace's session", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    seedIndex([{ id: B, ms: 1787763494998, root: OTHER }]);
    expect(
      discoverFxSessionId({ cwd: WORKSPACE, spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("never claims a session that predates the seat", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    seedIndex([{ id: OLD, ms: 1787249073205, root: WORKSPACE }]);
    expect(
      discoverFxSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 1787761861883,
        graceMs: 0,
        home,
      }),
    ).toBeUndefined();
  });

  it("refuses two same-workspace index sessions in the discovery window rather than binding both seats to the newest", () => {
    // Isolated index probe from the 2026-09-14 PTY matrix: both spawn times
    // returned BBBBBBBBBBBB before uniqueness. That pins the earlier seat to a
    // sibling session and can attribute the other seat's ACK/idle evidence.
    home = mkdtempSync(join(tmpdir(), "fx-"));
    const earlier = "AAAAAAAAAAAA";
    const newest = "BBBBBBBBBBBB";
    seedIndex([
      { id: earlier, ms: 10_000, root: WORKSPACE },
      { id: newest, ms: 10_100, root: WORKSPACE },
    ]);
    expect(
      discoverFxSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 10_000,
        home,
      }),
    ).toBeUndefined();
    expect(
      discoverFxSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 10_100,
        home,
      }),
    ).toBeUndefined();
  });

  it("falls back to id timestamps when the index is unusable, but only when unambiguous", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    // A schema this reader was not written against: fields may have moved, so
    // the index is not read at all.
    seedIndex([{ id: A, ms: 1787761861883, root: WORKSPACE }], 99);
    seedDirs([OLD, A]);
    expect(
      discoverFxSessionId({ cwd: WORKSPACE, spawnedAtMs: 1787761861000, home }),
    ).toBe(A);

    // Two sessions after the floor and no workspace evidence: an honest
    // "unknown" beats a coin flip that pins the seat to the wrong session.
    seedDirs([B]);
    expect(
      discoverFxSessionId({ cwd: WORKSPACE, spawnedAtMs: 1787761861000, home }),
    ).toBeUndefined();
  });

  it("answers undefined while fx has written nothing", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    mkdirSync(fxSessionsRoot(home), { recursive: true });
    expect(
      discoverFxSessionId({ cwd: WORKSPACE, spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("claims a 0.0.8 short id from the index when created_at_ms is present", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    seedIndex([{ id: SHORT, ms: 1787761861883, root: WORKSPACE }]);
    expect(
      discoverFxSessionId({
        cwd: WORKSPACE,
        spawnedAtMs: 1787761861000,
        home,
      }),
    ).toBe(SHORT);
  });

  it("falls back to a 0.0.8 short id directory when the index is unusable and the seat is unambiguous", () => {
    home = mkdtempSync(join(tmpdir(), "fx-"));
    seedIndex([{ id: SHORT, ms: 1787761861883, root: WORKSPACE }], 99);
    seedDirs([SHORT]);
    const spawnedAtMs = Date.now();
    expect(
      discoverFxSessionId({ cwd: WORKSPACE, spawnedAtMs, home }),
    ).toBe(SHORT);
  });
});

describe("fx models enumeration", () => {
  it("reads the ids fx prints", () => {
    // Trimmed from real `fx models --json` output.
    const stdout = JSON.stringify({
      kind: "models",
      count: 3,
      shown_count: 3,
      ids: ["anthropic/claude-opus-5", "zai/glm-5.3-flash", "anthropic/claude-opus-5"],
    });
    expect(parseFxModelsJson(stdout).models).toEqual([
      { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5" },
      { id: "zai/glm-5.3-flash", label: "zai/glm-5.3-flash" },
    ]);
  });

  it("fails soft on anything it does not recognize", () => {
    for (const bad of ["", "not json", JSON.stringify({ kind: "status" })]) {
      const parsed = parseFxModelsJson(bad);
      expect(parsed.models).toEqual([]);
      expect(parsed.error?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("fx launch shape", () => {
  it("carries dials in the environment, never in argv", () => {
    const launch = resolveManagedLaunch(
      "fx",
      { model: "anthropic/claude-opus-5", permissionMode: "ask" },
      {},
    );
    expect(launch.argv).toEqual(["fx"]);
    expect(launch.env?.FX_MODEL).toBe("anthropic/claude-opus-5");
    expect(launch.env?.FX_PERMISSION_MODE).toBe("ask");
  });

  it("resumes an exact id and never the latest session", () => {
    expect(resolveManagedLaunch("fx", { resumeId: A }, {}).argv).toEqual([
      "fx",
      "--resume",
      A,
    ]);
    // Every id-less form fx offers means "whatever ran last". (`-r` is fx's
    // picker but the NAMED resume flag elsewhere, so it is guarded by never
    // being emitted rather than by a blanket strip.)
    expect(
      stripIdlessSessionContinue(["fx", "--resume", "last"]),
    ).toEqual(["fx"]);
    expect(stripIdlessSessionContinue(["fx", "--resume"])).toEqual(["fx"]);
    expect(stripIdlessSessionContinue(["fx", "--resume-last"])).toEqual(["fx"]);
    expect(stripIdlessSessionContinue(["fx", "--continue"])).toEqual(["fx"]);
    // A named resume survives untouched.
    expect(stripIdlessSessionContinue(["fx", "--resume", A])).toEqual([
      "fx",
      "--resume",
      A,
    ]);
  });

  it("claims only what fx actually offers", () => {
    expect(FX_TEMPLATE.probedVersion).toBe("0.0.7");
    expect(FX_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(FX_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(FX_TEMPLATE.argvSpec.promptMode).toBe("none");
    // Seat dials stay in the environment. 0.0.8 adds --full-access / --yolo
    // argv; Junto must not emit them.
    expect(FX_TEMPLATE.argvSpec.modelFlag).toBeUndefined();
    expect(FX_TEMPLATE.argvSpec.effortFlag).toBeUndefined();
    expect(FX_TEMPLATE.argvSpec.permissionModeFlag).toBeUndefined();
    expect(FX_TEMPLATE.argvSpec.systemPromptFlag).toBeUndefined();
    // No permission default: fx's stock auto mode spends the operator's money.
    expect(FX_TEMPLATE.defaultPermissionMode).toBeUndefined();
    expect(FX_TEMPLATE.efforts).toEqual([]);
  });

  it("never emits 0.0.8 --full-access or --yolo argv", () => {
    const launch = resolveManagedLaunch(
      "fx",
      { permissionMode: "full-access", resumeId: SHORT },
      {},
    );
    expect(launch.argv).toEqual(["fx", "--resume", SHORT]);
    expect(launch.argv).not.toContain("--full-access");
    expect(launch.argv).not.toContain("--yolo");
    expect(launch.env?.FX_PERMISSION_MODE).toBe("full-access");
  });

  it("scrubs the ambient dials a nested fx seat would inherit", () => {
    for (const key of [
      "FX_MODEL",
      "FX_PERMISSION_MODE",
      "FX_MAX_AGENT_STEPS",
      "FX_RECORD",
      "FX_RECORD_INPUT",
    ]) {
      expect(SPAWN_ENV_SCRUB).toContain(key);
    }
  });
});

describe("fx seat state", () => {
  // Frames transcribed from a live fx 0.0.6 PTY capture.
  const snap = (title: string, lines: readonly string[]): ObserverGridSnapshot => ({
    cols: 120,
    rows: lines.length,
    lines: [...lines],
    text: lines.join("\n"),
    signals: {
      title,
      osc9: "",
      modes: {
        bracketedPaste: true,
        synchronizedOutput: false,
        altScreen: false,
        mouseModes: [],
      },
    },
    seq: 1n,
    epoch: "e1",
    bindingId: "b1",
  });

  const TITLE = "fx \u00B7 fx-probe \u00B7 zai/glm-5.3-flash";
  const FOOTER = "auto \u00B7 glm-5.3-flash";

  it("reads a live turn as working", () => {
    const r = evaluate(
      snap(TITLE, [
        "┃ Reply with the single word PONG and nothing else.",
        "• Thinking (2s) (↑13 ↓0)",
        "┃",
        FOOTER,
      ]),
      { harness: "fx" },
    );
    expect(r.state).toBe("working");
    expect(r.ruleId).toBe("status_line_working");
  });

  it("reads the settled frame as idle even though the meter is still there", () => {
    // The token meter survives the turn; only the bullet line does not. A rule
    // keyed on the meter would pin this finished seat to working forever.
    const r = evaluate(
      snap("fx \u00B7 Reply with the single word PONG \u00B7 zai/glm-5.3-flash", [
        "┃ Reply with the single word PONG and nothing else.",
        "  PONG",
        "  5s (↑13 ↓4)",
        "┃",
        FOOTER,
      ]),
      { harness: "fx" },
    );
    expect(r.state).toBe("idle");
    expect(r.ruleId).toBe("empty_composer_idle");
  });

  it("reads a fresh seat as idle", () => {
    const r = evaluate(
      snap(TITLE, [
        "\u{1D453}x v0.0.6 \u00B7 Run /help for commands",
        "┃",
        FOOTER,
      ]),
      { harness: "fx" },
    );
    expect(r.state).toBe("idle");
  });

  it("holds a composer draft as idle, not working", () => {
    const r = evaluate(
      snap(TITLE, ["┃ half a thought", FOOTER]),
      { harness: "fx" },
    );
    expect(r.state).toBe("idle");
    expect(r.ruleId).toBe("composer_draft_idle");
  });

  it("reads a tool-permission dialog as attention", () => {
    const r = evaluate(
      snap(TITLE, [
        "Run `rm -rf build`?",
        "  Allow once",
        "  Allow for this session",
        "  Reject",
      ]),
      { harness: "fx" },
    );
    expect(r.state).toBe("attention");
    expect(r.visibleAttention).toBe(true);
  });
});
