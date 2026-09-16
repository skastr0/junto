import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_RULES_FILENAME,
  agentRulesDirFor,
  writeAgentRulesDir,
} from "../src/main/junto/term/agent-rules-dir";
import { planManagedSpawn } from "../src/main/junto/term/managed-spawn-plan";
import { resolveManagedLaunchPlan } from "../src/shared/managed-terminal-launch";
import { AGY_TEMPLATE } from "../src/shared/managed-terminal-templates";
import { __resetJuntoHomeCache } from "../src/shared/junto-home";

/**
 * Antigravity has no system-prompt flag, so its Tier-A carrier is a DIRECTORY:
 * `--add-dir <dir>` mounts an app-owned dir whose AGENTS.md loads as doctrine.
 * Official 1.2.1 best-practices also parse a workspace-root AGENTS.md /
 * GEMINI.md; Junto still writes only the app-owned dir. The 1.1.20
 * added-dir canary was not re-run on 1.2.1 (UNVERIFIED).
 */
describe("agy doctrine rides an app-owned --add-dir rules directory", () => {
  const seatInjection = {
    seatBound: true,
    connected: true,
    seatRef: "agent-01M0R1HZ4J8MB2NX1G7R0R87TR",
    connectedTargets: [{ id: "task-01", kind: "task" }],
  };

  let tmpHome: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vellum-agy-rules-"));
    priorHome = process.env.JUNTO_HOME;
    process.env.JUNTO_HOME = tmpHome;
    __resetJuntoHomeCache();
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.JUNTO_HOME;
    else process.env.JUNTO_HOME = priorHome;
    __resetJuntoHomeCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("declares the directory carrier and Tier A", () => {
    expect(AGY_TEMPLATE.probedVersion).toBe("1.2.1");
    expect(AGY_TEMPLATE.argvSpec.rulesDirFlag).toBe("--add-dir");
    expect(AGY_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(AGY_TEMPLATE.injectionSpec.flags).toEqual(["--add-dir"]);
    expect(AGY_TEMPLATE.capabilityBadges.instructionInjection).toBe("A");
    expect(AGY_TEMPLATE.capabilityBadges.attentionSource).toContain(
      "Run this command?",
    );
    // No system-prompt flag was invented for a harness that has none.
    expect(AGY_TEMPLATE.argvSpec.systemPromptFlag).toBeUndefined();
  });

  it("writes AGENTS.md under the app home, never the user workspace", () => {
    const dir = writeAgentRulesDir({
      seatRef: "agent-01",
      doctrine: "# doctrine\n\nclaim tasks",
    });
    expect(dir).toBe(agentRulesDirFor("agent-01"));
    expect(dir?.startsWith(path.join(tmpHome, ".junto"))).toBe(true);
    expect(
      fs.readFileSync(path.join(dir!, AGENT_RULES_FILENAME), "utf8"),
    ).toContain("claim tasks");
  });

  it("refuses a seat ref that would escape the rules root", () => {
    const dir = writeAgentRulesDir({
      seatRef: "../../../etc",
      doctrine: "x",
    });
    expect(dir?.startsWith(path.join(tmpHome, ".junto"))).toBe(true);
    expect(dir).not.toContain("..");
  });

  it("spawn mounts the seat's rules dir and the file holds the doctrine", () => {
    const plan = planManagedSpawn({
      harness: "agy",
      agentKey: "local:agy",
      injection: seatInjection,
    });
    const argv = plan?.launch.argv ?? [];
    const dir = agentRulesDirFor(seatInjection.seatRef);
    expect(argv).toContain("--add-dir");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(dir);
    const body = fs.readFileSync(path.join(dir!, AGENT_RULES_FILENAME), "utf8");
    expect(body).toContain("Junto");
    expect(body).toContain("junto");
    // Tier A: the doctrine is a spawn-time fact, not a typed first message.
    expect(plan?.firstTypedMessage).toBeUndefined();
  });

  it("an unconnected seat gets no rules dir at all", () => {
    const plan = planManagedSpawn({
      harness: "agy",
      agentKey: "local:agy",
      injection: { seatBound: false, connected: false, seatRef: "agent-02" },
    });
    expect(plan?.launch.argv).not.toContain("--add-dir");
    expect(fs.existsSync(agentRulesDirFor("agent-02")!)).toBe(false);
  });

  it("cold resume rides --conversation <id> and re-arms nothing", () => {
    const conversation = "d2d461c6-8f41-4bd4-82c6-6f0266657bb0";
    const plan = planManagedSpawn({
      harness: "agy",
      agentKey: "local:agy",
      sessionId: conversation,
      // Resume proof lives on this host's disk; without it the planner falls
      // open to a fresh pin, which is the shape asserted here.
      resume: false,
      injection: seatInjection,
    });
    const argv = plan?.launch.argv ?? [];
    expect(argv).not.toContain("--continue");
    expect(argv).not.toContain("-c");

    const resumed = resolveManagedLaunchPlan("agy", {
      resumeId: conversation,
      model: "gemini-3.7-flash-high",
    });
    expect((resumed.launch.argv ?? []).slice(0, 3)).toEqual([
      "agy",
      "--conversation",
      conversation,
    ]);
  });

  it("falls back to typed delivery when no rules dir was written", () => {
    // The renderer (and any host with a failed write) has no directory to
    // mount. The seat must still be briefed rather than launched silent.
    const plan = resolveManagedLaunchPlan("agy", { injection: seatInjection });
    const argv = plan.launch.argv ?? [];
    expect(argv).not.toContain("--add-dir");
    const carried = plan.firstTypedMessage ?? argv[argv.indexOf("-i") + 1];
    expect(carried).toContain("Junto");
  });
});
