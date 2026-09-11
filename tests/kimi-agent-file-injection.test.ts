/**
 * Kimi's Tier-A carrier is a file.
 *
 * The harness has no system-prompt flag, so briefing a seat before its first
 * turn means writing a Markdown agent definition and passing `--agent-file`.
 * Two things have to hold: the frontmatter must be exactly the schema Kimi
 * validates pre-flight (a bad key exits 1 before any model call), and a resumed
 * seat — where the flag cannot ride at all — must degrade to typed delivery
 * instead of launching with nothing.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_FILE_NAME,
  agentFileKey,
  agentFilePathFor,
  buildAgentFileSpec,
  writeAgentFileSpec,
} from "../src/main/vellum-command/term/agent-file-spec";
import {
  KIMI_TEMPLATE,
  templateFor,
} from "../src/shared/managed-terminal-templates";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";
import { planManagedSpawn } from "../src/main/vellum-command/term/managed-spawn-plan";
import { __setSessionExistenceHomeForTest } from "../src/main/vellum-command/term/session-existence";
import type { CanvasDoc } from "../src/shared/canvas";

const temps: string[] = [];
const originalVellumHome = process.env.VELLUM_COMMAND_HOME;

const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vellum-kimi-agent-file-"));
  temps.push(dir);
  return dir;
};

afterEach(() => {
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

// ── The agent definition ───────────────────────────────────────────────────

describe("agent-file spec", () => {
  it("emits exactly the verified frontmatter schema", () => {
    const spec = buildAgentFileSpec("SEAT DOCTRINE BODY")!;
    const [, frontmatter, ...rest] = spec.split("---\n");
    expect(frontmatter).toContain(`name: ${AGENT_FILE_NAME}`);
    expect(frontmatter).toContain("description: ");
    expect(rest.join("---\n")).toContain("SEAT DOCTRINE BODY");
    // Strict pre-flight validation: every key here must be one Kimi knows.
    for (const key of frontmatter.split("\n").filter(Boolean)) {
      expect(key.split(":")[0]).toMatch(/^(name|description|tools)$/);
    }
  });

  it("never emits allowed-tools, and quotes the tools wildcard", () => {
    const spec = buildAgentFileSpec("body")!;
    // `allowed-tools` is a Claude-side key Kimi warns it may misread.
    expect(spec).not.toContain("allowed-tools");
    // An unquoted * is a YAML alias indicator, not the wildcard string.
    expect(spec).toContain('tools: ["*"]');
    expect(spec).not.toMatch(/tools:\s*\[\s*\*/);
  });

  it("keeps the name kebab-case whatever the seat is called", () => {
    expect(AGENT_FILE_NAME).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it("refuses an empty doctrine rather than writing an empty briefing", () => {
    expect(buildAgentFileSpec("   ")).toBeUndefined();
    expect(
      writeAgentFileSpec({ seatRef: "agent-1", doctrine: "  ", home: tempHome() }),
    ).toBeUndefined();
  });

  it("keeps a crafted seat ref inside the app-owned root", () => {
    const home = tempHome();
    expect(agentFileKey("../../etc/passwd")).toBe("------etc-passwd");
    expect(agentFileKey("   ")).toBeUndefined();
    const path = agentFilePathFor("../../etc/passwd", home)!;
    expect(path.startsWith(join(home, ".vellum-command", "content", "agent-files"))).toBe(
      true,
    );
    expect(path).not.toContain("/etc/passwd");
  });

  it("writes the doctrine under the app's own home and returns the path", () => {
    const home = tempHome();
    const path = writeAgentFileSpec({
      seatRef: "agent-01M0R1XQR6FTCA1QBCDSH46QHM",
      doctrine: "DOCTRINE",
      home,
    })!;
    expect(path).toBe(
      join(
        home,
        ".vellum-command",
        "content",
        "agent-files",
        "agent-01M0R1XQR6FTCA1QBCDSH46QHM.md",
      ),
    );
    const written = readFileSync(path, "utf8");
    expect(written.startsWith("---\n")).toBe(true);
    expect(written).toContain("DOCTRINE");
  });
});

// ── The template ───────────────────────────────────────────────────────────

describe("kimi template declares Tier A honestly", () => {
  it("carries the agent-file flag and the A badges", () => {
    expect(KIMI_TEMPLATE.argvSpec.agentFlag).toBe("--agent-file");
    expect(KIMI_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(KIMI_TEMPLATE.injectionSpec.flags).toEqual(["--agent-file"]);
    expect(KIMI_TEMPLATE.capabilityBadges.instructionInjection).toBe("A");
    expect(KIMI_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["injection A", "agent file"]),
    );
    expect(KIMI_TEMPLATE.capabilityBadges.labels).not.toContain("injection B");
    // Still no system-prompt flag: the file IS the only carrier.
    expect(KIMI_TEMPLATE.argvSpec.systemPromptFlag).toBeUndefined();
    // `--agent-file` cannot combine with `--session`, so resume stays frozen.
    // Live 0.34.0 exits 1 on that pair.
    expect(KIMI_TEMPLATE.probedVersion).toBe("0.34.0");
    expect(KIMI_TEMPLATE.argvSpec.resumeReinjection).toBe("frozen");
  });
});

// ── Turn 1 without a paste, resume without a carrier ───────────────────────

const connectedSeat = {
  seatBound: true,
  connected: true,
  seatRef: "agent-01M0R1XQR6FTCA1QBCDSH46QHM",
  connectedTargets: [{ id: "task-1", kind: "task" }],
};

describe("kimi injection at spawn and on resume", () => {
  it("a fresh spawn mounts the file and types nothing", () => {
    const plan = resolveManagedLaunchPlan("kimi", {
      injection: connectedSeat,
      agentFile: "/tmp/seat.md",
    });
    expect(plan.launch.argv).toContain("--agent-file");
    expect(plan.launch.argv).toContain("/tmp/seat.md");
    // Turn 1 is briefed by the file: nothing is pasted into the PTY, and kimi
    // has no argv prompt slot to auto-submit either.
    expect(plan.firstTypedMessage).toBeUndefined();
    expect(plan.injection.inject).toBe(true);
    expect(plan.injection.tier).toBe("A");
  });

  it("with no file written, the seat degrades to Tier B typed delivery", () => {
    const plan = resolveManagedLaunchPlan("kimi", { injection: connectedSeat });
    expect(plan.launch.argv).not.toContain("--agent-file");
    expect(plan.firstTypedMessage).toBeTruthy();
    expect(plan.injection.inject).toBe(true);
  });

  it("a resume never carries --agent-file, even if a caller passes one", () => {
    const plan = resolveManagedLaunchPlan("kimi", {
      resumeId: "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
      agentFile: "/tmp/seat.md",
      model: "kimi-k3",
    });
    expect(plan.launch.argv).toContain("-S");
    expect(plan.launch.argv).toContain(
      "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
    );
    expect(plan.launch.argv).not.toContain("--agent-file");
    expect(plan.launch.argv).not.toContain("/tmp/seat.md");
    // The model still rides: resume re-passes every template-owned flag.
    expect(plan.launch.argv).toContain("-m");
    // 0.34.0 exits 1 if --agent-file rides beside -S.
    expect(
      plan.launch.argv.includes("-S") && plan.launch.argv.includes("--agent-file"),
    ).toBe(false);
  });

  it("a detached terminal gets no file and no doctrine", () => {
    const plan = resolveManagedLaunchPlan("kimi", {
      injection: { seatBound: false, connected: false },
      agentFile: "/tmp/seat.md",
    });
    expect(plan.launch.argv).not.toContain("--agent-file");
    expect(plan.firstTypedMessage).toBeUndefined();
    expect(plan.injection.inject).toBe(false);
  });

  it("an isolated canvas seat still gets the base doctrine by file", () => {
    // seatBound without edges is not silence: the seat is on the canvas, so it
    // gets the base doctrine and simply no edge contracts.
    const plan = resolveManagedLaunchPlan("kimi", {
      injection: { seatBound: true, connected: false },
      agentFile: "/tmp/seat.md",
    });
    expect(plan.launch.argv).toContain("--agent-file");
    expect(plan.firstTypedMessage).toBeUndefined();
  });
});

// ── The spawn host materializes it ─────────────────────────────────────────

const seatDoc = (sessionId?: string): { doc: CanvasDoc; nodeId: string } => {
  const nodeId = "agent-01M0R1XQR6FTCA1QBCDSH46QHM";
  const doc: CanvasDoc = {
    nodes: [
      {
        id: nodeId,
        type: "text",
        text: "kimi seat",
        x: 0,
        y: 0,
        ether: {
          entity: { kind: "agent" },
          terminal: {
            harness: "kimi",
            ...(sessionId ? { sessionId } : {}),
          },
        },
      },
      {
        id: "task-1",
        type: "text",
        text: "tasks",
        x: 10,
        y: 0,
        ether: { entity: { kind: "task" } },
      },
    ],
    edges: [{ id: "e1", fromNode: nodeId, toNode: "task-1" }],
  } as unknown as CanvasDoc;
  return { doc, nodeId };
};

describe("the spawning host writes the seat's agent file", () => {
  it("fresh spawn: doctrine on disk, path on argv, no typed paste", () => {
    const home = tempHome();
    process.env.VELLUM_COMMAND_HOME = home;
    const { doc, nodeId } = seatDoc();
    const plan = planManagedSpawn({ doc, nodeId, harness: "kimi" })!;
    const argv = plan.launch.argv!;
    const at = argv.indexOf("--agent-file");
    expect(at).toBeGreaterThan(-1);
    const path = argv[at + 1]!;
    expect(path.startsWith(home)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain(`name: ${AGENT_FILE_NAME}`);
    // The compiled doctrine, not a placeholder: it names the connected sink.
    expect(body).toContain("task-1");
    expect(plan.firstTypedMessage).toBeUndefined();
  });

  it("resume: no file is written and the launch is a plain -S resume", () => {
    const home = tempHome();
    process.env.VELLUM_COMMAND_HOME = home;
    const harnessHome = tempHome();
    const sid = "ses_7c6b5a49382716";
    mkdirSync(join(harnessHome, ".kimi-code", "sessions", "wd", sid), {
      recursive: true,
    });
    __setSessionExistenceHomeForTest(harnessHome);
    const { doc, nodeId } = seatDoc(sid);
    const plan = planManagedSpawn({
      doc,
      nodeId,
      harness: "kimi",
      sessionId: sid,
      resume: true,
    })!;
    const argv = plan.launch.argv!;
    expect(argv).toContain("-S");
    expect(argv).toContain(sid);
    expect(argv).not.toContain("--agent-file");
    // Tier B fallback means "no argv briefing", not "type the doctrine again":
    // the resumed session already holds it.
    expect(plan.firstTypedMessage).toBeUndefined();
    expect(plan.injection.inject).toBe(false);
  });

  it("only kimi takes this path — grok's agent file stays the caller's", () => {
    const home = tempHome();
    process.env.VELLUM_COMMAND_HOME = home;
    expect(templateFor("grok").argvSpec.systemPromptFlag).toBe("--rules");
    const { doc, nodeId } = seatDoc();
    const grokDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              ether: {
                ...n.ether,
                terminal: { harness: "grok" },
              },
            }
          : n,
      ),
    } as CanvasDoc;
    const plan = planManagedSpawn({
      doc: grokDoc,
      nodeId,
      harness: "grok",
    })!;
    const argv = plan.launch.argv!;
    expect(argv).not.toContain("--agent");
    expect(argv).toContain("--rules");
  });
});

/** Keep the temp-file helper honest about producing real files. */
const _touch = (path: string): void => writeFileSync(path, "", "utf8");
void _touch;
