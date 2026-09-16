import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOmpSessionId,
  encodeOmpWorkspaceDir,
  isOmpSessionId,
  ompSessionsDir,
} from "../src/main/junto/term/templates/omp-session";
import {
  OMP_TEMPLATE,
  SPAWN_ENV_SCRUB,
} from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import { evaluate } from "../src/main/junto/term/agent-state";
import type { ObserverGridSnapshot } from "../src/main/junto/term/observer/types";

// A real session filename from a probe run of omp 18.0.9.
const ID = "01a047a9-b043-7000-8238-77d95a659b41";
const FILE = `2026-08-28T09-18-18-179Z_${ID}.jsonl`;
const OLDER = "2026-06-24T19-30-19-402Z_019efb1c-a68a-7000-91ef-55adaeea53a6.jsonl";

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe("omp workspace encoding", () => {
  // Home and abs-wrap receipts from the 18.0.9 live run. The tmp scope is
  // the 18.1.16 installed `session-paths.ts` third case (`-tmp-<rel>`).
  const TMP = "/var/folders/f5/probe/T";

  it("is home-relative under $HOME", () => {
    expect(
      encodeOmpWorkspaceDir("/Users/me/Projects/vellum", "/Users/me", TMP),
    ).toBe("-Projects-vellum");
  });

  it("is tmp-relative under os.tmpdir()", () => {
    expect(encodeOmpWorkspaceDir(`${TMP}/seat`, "/Users/me", TMP)).toBe(
      "-tmp-seat",
    );
    expect(encodeOmpWorkspaceDir(`${TMP}/a/b`, "/Users/me", TMP)).toBe(
      "-tmp-a-b",
    );
    expect(encodeOmpWorkspaceDir(TMP, "/Users/me", TMP)).toBe("-tmp");
  });

  it("is the dash-wrapped full path outside $HOME and tmpdir", () => {
    // This machine's tmpdir is /var/folders/…/T, so the 18.0.9
    // /private/tmp/omp-probe tree stays the abs wrap.
    expect(
      encodeOmpWorkspaceDir("/private/tmp/omp-probe", "/Users/me", TMP),
    ).toBe("--private-tmp-omp-probe--");
  });

  it("encodes /private/tmp as tmp-relative when that is os.tmpdir()", () => {
    expect(
      encodeOmpWorkspaceDir("/private/tmp/omp-probe", "/Users/me", "/private/tmp"),
    ).toBe("-tmp-omp-probe");
  });

  it("keeps a trailing slash from changing the answer", () => {
    expect(
      encodeOmpWorkspaceDir("/Users/me/Projects/", "/Users/me/", TMP),
    ).toBe("-Projects");
  });

  it("prefers home when a cwd could also sit under tmpdir", () => {
    expect(
      encodeOmpWorkspaceDir("/Users/me/Projects/vellum", "/Users/me", "/Users/me"),
    ).toBe("-Projects-vellum");
  });
});

describe("omp session discovery", () => {
  const seed = (cwd: string, files: readonly string[]): void => {
    const dir = ompSessionsDir(cwd, home!);
    mkdirSync(dir, { recursive: true });
    for (const name of files) writeFileSync(join(dir, name), "{}\n", "utf8");
  };

  it("returns the uuid, which is what --resume takes", () => {
    home = mkdtempSync(join(tmpdir(), "omp-"));
    seed("/work/repo", [FILE]);
    expect(
      discoverOmpSessionId({ cwd: "/work/repo", spawnedAtMs: 0, home }),
    ).toBe(ID);
  });

  it("finds a session whose cwd is under the tmp scope", () => {
    home = mkdtempSync(join(tmpdir(), "omp-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "omp-tmp-"));
    try {
      const cwd = join(tmpRoot, "seat");
      const dir = ompSessionsDir(cwd, home, tmpRoot);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, FILE), "{}\n", "utf8");
      expect(encodeOmpWorkspaceDir(cwd, home, tmpRoot)).toBe("-tmp-seat");
      expect(
        discoverOmpSessionId({
          cwd,
          spawnedAtMs: 0,
          home,
          tmpDir: tmpRoot,
        }),
      ).toBe(ID);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("never reaches into another workspace's directory", () => {
    home = mkdtempSync(join(tmpdir(), "omp-"));
    seed("/work/other", [FILE]);
    expect(
      discoverOmpSessionId({ cwd: "/work/repo", spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("ignores a session written before this seat spawned", () => {
    home = mkdtempSync(join(tmpdir(), "omp-"));
    seed("/work/repo", [OLDER]);
    expect(
      discoverOmpSessionId({
        cwd: "/work/repo",
        // Far in the future relative to the file just written.
        spawnedAtMs: Date.now() + 60_000,
        graceMs: 0,
        home,
      }),
    ).toBeUndefined();
  });

  it("answers undefined when omp has written nothing", () => {
    home = mkdtempSync(join(tmpdir(), "omp-"));
    expect(
      discoverOmpSessionId({ cwd: "/work/repo", spawnedAtMs: 0, home }),
    ).toBeUndefined();
  });

  it("recognizes ids and rejects filenames", () => {
    expect(isOmpSessionId(ID)).toBe(true);
    expect(isOmpSessionId(FILE)).toBe(false);
  });
});

describe("omp launch shape", () => {
  it("carries doctrine on argv — Tier A, not a typed message", () => {
    const launch = resolveManagedLaunch(
      "omp",
      {
        model: "opus",
        effort: "high",
        permissionMode: "write",
        systemPrompt: "seat doctrine",
        prompt: "get to work",
      },
      {},
    );
    expect(launch.argv).toEqual([
      "omp",
      "--model",
      "opus",
      "--thinking",
      "high",
      "--approval-mode",
      "write",
      "--append-system-prompt",
      "seat doctrine",
      "get to work",
    ]);
    // Last-write-wins on 18.1.16: one flag, never two fragments.
    expect(
      launch.argv?.filter((token) => token === "--append-system-prompt"),
    ).toHaveLength(1);
    expect(OMP_TEMPLATE.injectionSpec.description).not.toMatch(/repeatable/i);
  });

  it("re-passes every dial on resume, by exact id", () => {
    const launch = resolveManagedLaunch(
      "omp",
      { resumeId: ID, model: "opus", effort: "max", prompt: "carry on" },
      {},
    );
    expect(launch.argv).toEqual([
      "omp",
      "--resume",
      ID,
      "--model",
      "opus",
      "--thinking",
      "max",
      "carry on",
    ]);
    expect(OMP_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
  });

  it("claims Tier A and capture, and offers omp's own thinking levels", () => {
    expect(OMP_TEMPLATE.probedVersion).toBe("18.1.16");
    expect(OMP_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(OMP_TEMPLATE.injectionSpec.flags).toEqual(["--append-system-prompt"]);
    expect(OMP_TEMPLATE.capabilityBadges.instructionInjection).toBe("A");
    expect(OMP_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(OMP_TEMPLATE.displayName).toBe("Oh My Pi");
    expect(OMP_TEMPLATE.efforts).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "auto",
    ]);
  });

  it("scrubs the pi-family env a nested seat would inherit", () => {
    for (const key of [
      "OMP_PROFILE",
      "PI_CODING_AGENT_DIR",
      "PI_NO_PTY",
      "PI_SMOL_MODEL",
      "PI_SLOW_MODEL",
      "PI_PLAN_MODEL",
    ]) {
      expect(SPAWN_ENV_SCRUB).toContain(key);
    }
  });
});

describe("omp seat state", () => {
  // Frames transcribed from a live omp 18.0.9 PTY capture, with the
  // configured provider/model/quota labels neutralized like the P1 corpus.
  const STATUS =
    "   \u00B7  synth-model-1 (1x usage) \u00B7 high \u00B7 omp-probe \u00B7 0.0%/1M ";

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
        synchronizedOutput: true,
        altScreen: false,
        mouseModes: [],
      },
    },
    seq: 1n,
    epoch: "e1",
    bindingId: "b1",
  });

  it("reads a running turn as working", () => {
    const r = evaluate(
      snap("π ⠹ omp-probe", [
        " Reply with exactly: PONG",
        " ⠼ Working… ⟨esc⟩",
        STATUS,
      ]),
      { harness: "omp" },
    );
    expect(r.state).toBe("working");
    expect(r.ruleId).toBe("osc_title_working");
  });

  it("reads a waiting seat as idle", () => {
    const r = evaluate(
      snap("π > omp-probe", [" Tip: Press ctrl+r to search", STATUS]),
      { harness: "omp" },
    );
    expect(r.state).toBe("idle");
    expect(r.ruleId).toBe("osc_title_idle");
  });

  it("stays idle once the turn lands, under the generated session title", () => {
    // The title becomes the session name but keeps the `>` marker; the status
    // bar is unchanged from the working frame, so it proves nothing alone.
    const r = evaluate(
      snap("π > Reply with PONG", [
        " Reply with exactly: PONG",
        " PONG",
        STATUS,
      ]),
      { harness: "omp" },
    );
    expect(r.state).toBe("idle");
  });

  it("reads an approval dialog as attention", () => {
    const r = evaluate(
      snap("π > omp-probe", [
        " Run `rm -rf build`?",
        "  Allow once",
        "  Allow all",
        "  Reject",
        STATUS,
      ]),
      { harness: "omp" },
    );
    expect(r.state).toBe("attention");
    expect(r.visibleAttention).toBe(true);
  });
});
