/**
 * Cursor: a pinned session and an effort that lives inside the model.
 *
 * The seat's session id is minted when the node is authored, passed as
 * `--new-session-id`, and resumed by `--resume <id>` — the exact session, not a
 * fork. Effort is not a flag on this harness: it rides in the model value as a
 * hyphenated catalog slug (`claude-opus-4-8-high`). A picker effort only
 * means something with a model. `[effort=…]` is rejected on 2026.09.10.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURSOR_TEMPLATE,
  templateFor,
} from "../src/shared/managed-terminal-templates";
import {
  resolveManagedLaunch,
  withModelBracketOption,
  withModelEffortSlug,
} from "../src/shared/managed-terminal-launch";
import {
  __setSessionExistenceHomeForTest,
  harnessSessionExists,
  isPinSessionHarness,
  parseHarnessSessionArgv,
  reclaimOrphanedHarnessArgv,
} from "../src/main/junto/term/session-existence";
import { launchForManagedSpawn } from "../src/main/junto/term/managed-spawn-plan";
import { makeManagedAgentNode } from "../src/renderer/lib/node-factories";
import type { CanvasDoc } from "../src/shared/canvas";

const temps: string[] = [];
const originalJuntoHome = process.env.JUNTO_HOME;

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "junto-cursor-pin-"));
  temps.push(dir);
  return dir;
};

/** The durable receipt: ~/.cursor/chats/<workspaceHash>/<id>/meta.json */
const seedCursorChat = (home: string, sessionId: string): void => {
  const dir = join(home, ".cursor", "chats", "ws-4f2a", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), "{}");
};

afterEach(() => {
  if (originalJuntoHome === undefined) delete process.env.JUNTO_HOME;
  else process.env.JUNTO_HOME = originalJuntoHome;
  __setSessionExistenceHomeForTest(undefined);
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ── The template ───────────────────────────────────────────────────────────

describe("cursor template declares a pin, not a capture", () => {
  it("names the pin flag, the resume flag, and the bracket key", () => {
    expect(CURSOR_TEMPLATE.argvSpec.sessionIdFlag).toBe("--new-session-id");
    expect(CURSOR_TEMPLATE.argvSpec.resumeMode).toBe("flag");
    expect(CURSOR_TEMPLATE.argvSpec.resumeFlag).toBe("--resume");
    expect(CURSOR_TEMPLATE.argvSpec.effortModelBracketKey).toBe("effort");
    // Effort is NOT a flag on this harness.
    expect(CURSOR_TEMPLATE.argvSpec.effortFlag).toBeUndefined();
    expect(CURSOR_TEMPLATE.capabilityBadges.sessionId).toBe("pin");
    expect(CURSOR_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["session pin", "effort in model"]),
    );
    expect(CURSOR_TEMPLATE.capabilityBadges.labels).not.toContain(
      "capture session",
    );
    expect(isPinSessionHarness("cursor")).toBe(true);
  });

  it("offers the effort suffixes agent models enumerates", () => {
    expect(CURSOR_TEMPLATE.probedVersion).toBe("2026.09.10-fd3934a");
    expect(CURSOR_TEMPLATE.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "extra-high",
      "max",
    ]);
  });
});

// ── Hyphenated catalog effort ──────────────────────────────────────────────

describe("hyphenated model effort slugs", () => {
  it("keeps withModelBracketOption available for non-effort brackets", () => {
    expect(withModelBracketOption("composer-2.5", "fast", "false")).toBe(
      "composer-2.5[fast=false]",
    );
    expect(
      withModelBracketOption("claude-opus-4-8[context=1m]", "fast", "false"),
    ).toBe("claude-opus-4-8[context=1m,fast=false]");
  });

  it("hyphenates, replaces a trailing suffix, and keeps other brackets", () => {
    expect(withModelEffortSlug("claude-opus-4-8", "high")).toBe(
      "claude-opus-4-8-high",
    );
    expect(withModelEffortSlug("claude-opus-4-8-low", "high")).toBe(
      "claude-opus-4-8-high",
    );
    expect(withModelEffortSlug("claude-opus-4-8-high-fast", "low")).toBe(
      "claude-opus-4-8-low-fast",
    );
    expect(withModelEffortSlug("claude-opus-4-8-xhigh", "xhigh")).toBe(
      "claude-opus-4-8-xhigh",
    );
    expect(withModelEffortSlug("composer-2.5[fast=false]", "high")).toBe(
      "composer-2.5-high[fast=false]",
    );
    expect(
      withModelEffortSlug("claude-opus-4-8[context=1m,effort=low]", "high"),
    ).toBe("claude-opus-4-8-high[context=1m]");
  });

  it("puts the picker effort on the catalog slug, never on a flag or bracket", () => {
    const argv = resolveManagedLaunch("cursor", {
      model: "claude-opus-4-8",
      effort: "high",
    }).argv!;
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-opus-4-8-high");
    expect(argv.join(" ")).not.toContain("[effort=");
    expect(argv).not.toContain("--effort");
    expect(argv).not.toContain("high");
  });

  it("passes through a working non-effort bracket when no effort is chosen", () => {
    const argv = resolveManagedLaunch("cursor", {
      model: "composer-2.5[fast=false]",
    }).argv!;
    expect(argv).toContain("composer-2.5[fast=false]");
    expect(argv.join(" ")).not.toContain("[effort=");
  });

  it("widens medium, xhigh, and max onto the catalog id", () => {
    expect(
      resolveManagedLaunch("cursor", {
        model: "claude-opus-4-8",
        effort: "medium",
      }).argv,
    ).toContain("claude-opus-4-8-medium");
    expect(
      resolveManagedLaunch("cursor", {
        model: "claude-opus-4-8",
        effort: "xhigh",
      }).argv,
    ).toContain("claude-opus-4-8-xhigh");
    expect(
      resolveManagedLaunch("cursor", {
        model: "claude-opus-4-8",
        effort: "max",
      }).argv,
    ).toContain("claude-opus-4-8-max");
  });

  it("drops an effort with no model rather than inventing one", () => {
    const argv = resolveManagedLaunch("cursor", { effort: "high" }).argv!;
    expect(argv.join(" ")).not.toContain("effort");
    expect(argv).not.toContain("--model");
  });

  it("leaves every other harness's effort exactly where it was", () => {
    const claude = resolveManagedLaunch("claude", {
      model: "opus",
      effort: "xhigh",
    }).argv!;
    expect(claude).toContain("--effort");
    expect(claude).toContain("xhigh");
    expect(claude).toContain("opus");
    const codex = resolveManagedLaunch("codex", {
      model: "gpt-5.3",
      effort: "high",
    }).argv!;
    expect(codex).toContain("-c");
    expect(codex).toContain('model_reasoning_effort="high"');
  });
});

// ── Pin at authoring, resume at wake ───────────────────────────────────────

describe("a cursor seat carries its session from the moment it is authored", () => {
  it("mints a UUID, stores it on the node, and pins it on argv", () => {
    const node = makeManagedAgentNode(0, 0, {
      harness: "cursor",
      host: "local",
      cwd: "/Users/me/proj",
    });
    const sid = node.ether!.terminal!.sessionId!;
    expect(sid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const argv = node.ether!.terminal!.launch!.argv!;
    expect(argv).toContain("--new-session-id");
    expect(argv[argv.indexOf("--new-session-id") + 1]).toBe(sid);
    expect(argv).not.toContain("--resume");
  });

  it("resume:true without proof re-pins instead of resuming a session that is not there", () => {
    delete process.env.JUNTO_HOME;
    __setSessionExistenceHomeForTest(tempHome());
    const node = makeManagedAgentNode(0, 0, {
      harness: "cursor",
      host: "local",
      cwd: "/Users/me/proj",
    });
    const sid = node.ether!.terminal!.sessionId!;
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "cursor",
      documentLaunch: node.ether!.terminal!.launch,
      resume: true,
      cwd: "/Users/me/proj",
    });
    const argv = launch!.argv ?? [];
    expect(argv).toContain("--new-session-id");
    expect(argv).toContain(sid);
    expect(argv).not.toContain("--resume");
  });

  it("resume:true with the chats receipt resumes that exact id, no fork", () => {
    delete process.env.JUNTO_HOME;
    const home = tempHome();
    const node = makeManagedAgentNode(0, 0, {
      harness: "cursor",
      host: "local",
      cwd: "/Users/me/proj",
    });
    const sid = node.ether!.terminal!.sessionId!;
    seedCursorChat(home, sid);
    __setSessionExistenceHomeForTest(home);
    expect(harnessSessionExists({ harness: "cursor", sessionId: sid })).toBe(
      true,
    );
    const doc: CanvasDoc = { nodes: [node], edges: [] };
    const { launch } = launchForManagedSpawn({
      doc,
      nodeId: node.id,
      harness: "cursor",
      documentLaunch: node.ether!.terminal!.launch,
      resume: true,
      cwd: "/Users/me/proj",
    });
    const argv = launch!.argv ?? [];
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe(sid);
    expect(argv).not.toContain("--new-session-id");
  });

  it("an id that has taken no turn yet is honestly not proven", () => {
    const home = tempHome();
    expect(
      harnessSessionExists({
        harness: "cursor",
        sessionId: "11111111-2222-4333-8444-555555555555",
        home,
      }),
    ).toBe(false);
  });
});

// ── Orphan reclaim ─────────────────────────────────────────────────────────

describe("reclaiming an orphaned cursor pin", () => {
  const sid = "7c1e9f60-8a2b-4c3d-9e4f-5a6b7c8d9e01";

  it("reads the pin off argv the harness actually uses", () => {
    expect(
      parseHarnessSessionArgv(["agent", "--trust", "--new-session-id", sid]),
    ).toEqual({ harness: "cursor", sessionId: sid, mode: "pin" });
    expect(parseHarnessSessionArgv(["agent", "--resume", sid])).toEqual({
      harness: "cursor",
      sessionId: sid,
      mode: "resume",
    });
  });

  it("turns a proven pin into a resume so a restart reclaims, not duplicates", () => {
    const home = tempHome();
    seedCursorChat(home, sid);
    __setSessionExistenceHomeForTest(home);
    expect(
      reclaimOrphanedHarnessArgv(["agent", "--trust", "--new-session-id", sid]),
    ).toEqual(["agent", "--trust", "--resume", sid]);
  });

  it("leaves an unproven pin alone", () => {
    __setSessionExistenceHomeForTest(tempHome());
    expect(
      reclaimOrphanedHarnessArgv(["agent", "--trust", "--new-session-id", sid]),
    ).toEqual(["agent", "--trust", "--new-session-id", sid]);
  });

  it("does not confuse another harness's pin flag with cursor's", () => {
    // Cursor's own flag is `--new-session-id`; `--session-id` is not its pin.
    expect(
      parseHarnessSessionArgv(["agent", "--session-id", sid]),
    ).toBeUndefined();
    expect(templateFor("claude").argvSpec.sessionIdFlag).toBe("--session-id");
  });
});
