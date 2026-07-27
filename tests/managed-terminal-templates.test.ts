import { describe, expect, it } from "vitest";
import {
  CLAUDE_MODEL_ALIASES,
  CLAUDE_TEMPLATE,
  CODEX_TEMPLATE,
  GROK_TEMPLATE,
  HERMES_TEMPLATE,
  HARNESS_IDS,
  MANAGED_TERMINAL_TEMPLATES,
  SPAWN_ENV_SCRUB,
  allTemplates,
  isHarnessId,
  templateFor,
} from "../src/shared/managed-terminal-templates";
import {
  buildSpawnEnv,
  resolveManagedLaunch,
  scrubSpawnEnv,
} from "../src/shared/managed-terminal-launch";
import {
  effortsFor,
  enumerateCodexModels,
  enumerateHermesProfiles,
  parseClaudeModelCache,
  parseCodexDebugModels,
  parseGrokModelsCache,
  parseHermesProfileList,
  readClaudeModels,
  readGrokModels,
} from "../src/main/vellum/term/templates/enumerate-models";

describe("managed-terminal templates (data)", () => {
  it("exports exactly the four v1 harnesses", () => {
    expect(HARNESS_IDS).toEqual(["claude", "codex", "grok", "hermes"]);
    expect(allTemplates()).toHaveLength(4);
    for (const id of HARNESS_IDS) {
      expect(isHarnessId(id)).toBe(true);
      expect(templateFor(id)).toBe(MANAGED_TERMINAL_TEMPLATES[id]);
      expect(MANAGED_TERMINAL_TEMPLATES[id].harness).toBe(id);
    }
    expect(isHarnessId("openclaw")).toBe(false);
  });

  it("marks injection tiers and release capability badges honestly", () => {
    expect(CLAUDE_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(GROK_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(CODEX_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(HERMES_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(CLAUDE_TEMPLATE.capabilityBadges.instructionInjection).toBe("A");
    expect(CLAUDE_TEMPLATE.capabilityBadges.sessionId).toBe("pin");
    expect(CLAUDE_TEMPLATE.capabilityBadges.hooks).toBe(false);
    expect(GROK_TEMPLATE.capabilityBadges.hooks).toBe(false);
    expect(CODEX_TEMPLATE.capabilityBadges.hooks).toBe(false);
    expect(HERMES_TEMPLATE.capabilityBadges.hooks).toBe(false);
    expect(GROK_TEMPLATE.capabilityBadges.sessionId).toBe("pin");
    expect(CODEX_TEMPLATE.capabilityBadges.sessionId).toBe("unavailable");
    expect(HERMES_TEMPLATE.capabilityBadges.sessionId).toBe("unavailable");
    expect(HERMES_TEMPLATE.capabilityBadges.effortAtSpawn).toBe(false);
    expect(GROK_TEMPLATE.capabilityBadges.requiresGitCwd).toBe(true);
    expect(HERMES_TEMPLATE.capabilityBadges.remote).toBe(true);
    expect(CLAUDE_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["OSC + grid"]),
    );
    expect(GROK_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["OSC + grid"]),
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["OSC + grid"]),
    );
    expect(CLAUDE_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("hooks");
    expect(GROK_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("hooks");
    expect(HERMES_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("hooks");
    expect(CLAUDE_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("cold resume");
    expect(GROK_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("cold resume");
    expect(CODEX_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["no cold resume"]),
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["no cold resume"]),
    );
    expect(CODEX_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("session capture");
    expect(HERMES_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain("session capture");
    expect(CLAUDE_TEMPLATE.capabilityBadges.stateFeed).not.toContain("hooks");
    expect(GROK_TEMPLATE.capabilityBadges.stateFeed).not.toContain("hooks");
    expect(HERMES_TEMPLATE.capabilityBadges.stateFeed).not.toContain("hooks");
    expect(CLAUDE_TEMPLATE.capabilityBadges.stateFeed).toBe("OSC → grid");
    expect(GROK_TEMPLATE.capabilityBadges.stateFeed).toBe("OSC → grid");
    expect(HERMES_TEMPLATE.capabilityBadges.stateFeed).toBe("OSC (--tui only) → grid");
    expect(GROK_TEMPLATE.capabilityBadges.attentionSource).toBe(
      "OSC title Action Required + footer/grid",
    );
  });

  it("shares the mandatory spawn env scrub list", () => {
    expect(SPAWN_ENV_SCRUB).toEqual([
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
    ]);
    for (const t of allTemplates()) {
      expect(t.envSpec.scrub).toEqual(SPAWN_ENV_SCRUB);
    }
  });

  it("uses hermes chat --tui (not headless -z)", () => {
    expect(HERMES_TEMPLATE.argvSpec.binary).toBe("hermes");
    expect(HERMES_TEMPLATE.argvSpec.prefix).toEqual(["chat", "--tui"]);
    expect(HERMES_TEMPLATE.argvSpec.promptMode).toBe("flag-q");
  });
});

describe("scrubSpawnEnv + buildSpawnEnv", () => {
  it("strips nested Claude session markers", () => {
    const scrubbed = scrubSpawnEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "yes",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      VELLUM_TOKEN: "tok",
      EMPTY: undefined,
    });
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      VELLUM_TOKEN: "tok",
    });
  });

  it("merges inject after scrub and refuses to reintroduce scrubbed keys", () => {
    const env = buildSpawnEnv(
      {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        HOME: "/home/op",
      },
      {
        VELLUM_SOCKET: "/tmp/work.sock",
        VELLUM_TOKEN: "t",
        CLAUDECODE: "evil",
        PATH: "/opt/vellum/bin:/usr/bin",
      },
    );
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe("/opt/vellum/bin:/usr/bin");
    expect(env.VELLUM_SOCKET).toBe("/tmp/work.sock");
    expect(env.HOME).toBe("/home/op");
  });
});

describe("resolveManagedLaunch argv", () => {
  const bareAmbient = { PATH: "/usr/bin", HOME: "/home/op" };

  it("claude: model, effort, permission, session pin, append-system-prompt, prompt", () => {
    const launch = resolveManagedLaunch(
      "claude",
      {
        model: "sonnet",
        effort: "high",
        permissionMode: "acceptEdits",
        sessionId: "11111111-1111-1111-1111-111111111111",
        systemPrompt: "call vellum onboard",
        prompt: "start the task",
        cwd: "/repo",
        env: { VELLUM_TOKEN: "t" },
      },
      bareAmbient,
    );
    expect(launch.kind).toBe("harness");
    expect(launch.cwd).toBe("/repo");
    expect(launch.argv).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--permission-mode",
      "acceptEdits",
      "--session-id",
      "11111111-1111-1111-1111-111111111111",
      "--append-system-prompt",
      "call vellum onboard",
      "start the task",
    ]);
    expect(launch.env?.VELLUM_TOKEN).toBe("t");
    expect(launch.env?.CLAUDECODE).toBeUndefined();
  });

  it("claude resume re-passes flags via --resume", () => {
    const launch = resolveManagedLaunch(
      "claude",
      { resumeId: "abc", model: "haiku", effort: "low" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "claude",
      "--resume",
      "abc",
      "--model",
      "haiku",
      "--effort",
      "low",
      "--permission-mode",
      "default",
    ]);
  });

  it("codex: prompt, -a approval, -m model, -c effort config key", () => {
    const launch = resolveManagedLaunch(
      "codex",
      {
        model: "gpt-5.4-mini",
        effort: "low",
        permissionMode: "never",
        prompt: "Reply with OK",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "codex",
      "-m",
      "gpt-5.4-mini",
      "-c",
      'model_reasoning_effort="low"',
      "-a",
      "never",
      "Reply with OK",
    ]);
  });

  it("codex resume is a subcommand and re-passes flags", () => {
    const launch = resolveManagedLaunch(
      "codex",
      {
        resumeId: "thread-xyz",
        model: "gpt-5.4-mini",
        effort: "high",
        permissionMode: "on-request",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "codex",
      "resume",
      "thread-xyz",
      "-m",
      "gpt-5.4-mini",
      "-c",
      'model_reasoning_effort="high"',
      "-a",
      "on-request",
    ]);
  });

  it("grok: session pin, reasoning effort, agent file, git cwd", () => {
    const launch = resolveManagedLaunch(
      "grok",
      {
        model: "grok-4.5",
        effort: "low",
        sessionId: "eacbbdbf-e813-5648-927c-a357e5eddaad",
        agentFile: "/tmp/vellum-agent.md",
        prompt: "Reply with OK",
        cwd: "/repo/git-project",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "grok",
      "-m",
      "grok-4.5",
      "--reasoning-effort",
      "low",
      "--permission-mode",
      "default",
      "--session-id",
      "eacbbdbf-e813-5648-927c-a357e5eddaad",
      "--agent",
      "/tmp/vellum-agent.md",
      "Reply with OK",
    ]);
    expect(launch.cwd).toBe("/repo/git-project");
    expect(GROK_TEMPLATE.capabilityBadges.requiresGitCwd).toBe(true);
  });

  it("grok prefers --rules when systemPrompt is set without agentFile", () => {
    const launch = resolveManagedLaunch(
      "grok",
      { systemPrompt: "doctrine text", permissionMode: "default" },
      bareAmbient,
    );
    expect(launch.argv).toContain("--rules");
    expect(launch.argv).toContain("doctrine text");
    expect(launch.argv).not.toContain("--agent");
  });

  it("hermes: chat --tui -q with profile and model", () => {
    const launch = resolveManagedLaunch(
      "hermes",
      {
        profile: "default",
        model: "gpt-5.4-mini",
        prompt: "Reply with OK",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "hermes",
      "chat",
      "--tui",
      "--profile",
      "default",
      "-m",
      "gpt-5.4-mini",
      "-q",
      "Reply with OK",
    ]);
  });

  it("hermes resume re-passes -m and uses -r", () => {
    const launch = resolveManagedLaunch(
      "hermes",
      {
        resumeId: "20000101_120001_abc001",
        model: "gpt-5.4-mini",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "hermes",
      "chat",
      "--tui",
      "-r",
      "20000101_120001_abc001",
      "-m",
      "gpt-5.4-mini",
    ]);
  });

  it("hermes --yolo only when permissionMode enables it", () => {
    const on = resolveManagedLaunch("hermes", { permissionMode: "yolo" }, bareAmbient);
    expect(on.argv).toContain("--yolo");
    const off = resolveManagedLaunch(
      "hermes",
      { permissionMode: "off" },
      bareAmbient,
    );
    expect(off.argv).not.toContain("--yolo");
  });

  it("defaults: click harness → argv with default permission only", () => {
    const launch = resolveManagedLaunch("claude", {}, bareAmbient);
    expect(launch.argv).toEqual(["claude", "--permission-mode", "default"]);
  });

  it("rejects unknown harness ids", () => {
    expect(() =>
      resolveManagedLaunch("openclaw" as never, {}, bareAmbient),
    ).toThrow(/unknown managed harness/);
  });
});

describe("model enumeration (fail-soft)", () => {
  it("parseClaudeModelCache reads additionalModelOptionsCache + aliases", () => {
    const raw = JSON.stringify({
      additionalModelOptionsCache: [
        {
          value: "claude-fable-5[1m]",
          label: "Fable",
          description: "Most capable",
        },
      ],
    });
    const { models, error } = parseClaudeModelCache(raw);
    expect(error).toBeUndefined();
    expect(models[0]).toMatchObject({
      id: "claude-fable-5[1m]",
      label: "Fable",
    });
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining([...CLAUDE_MODEL_ALIASES]),
    );
  });

  it("readClaudeModels fails soft on missing file", () => {
    const result = readClaudeModels("/no/such/home", () => undefined);
    expect(result.source).toBe("aliases");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.error).toMatch(/missing/);
  });

  it("readClaudeModels uses injectable reader", () => {
    const raw = JSON.stringify({
      additionalModelOptionsCache: [{ value: "claude-sonnet-5", label: "Sonnet" }],
    });
    const result = readClaudeModels("/home/op", (path) => {
      expect(path).toBe("/home/op/.claude.json");
      return raw;
    });
    expect(result.source).toBe("cache");
    expect(result.models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
  });

  it("parseGrokModelsCache reads models map", () => {
    const raw = JSON.stringify({
      fetched_at: "2026-07-26T00:00:00Z",
      models: {
        "grok-4.5": {
          info: {
            id: "grok-4.5",
            name: "Grok 4.5",
            description: "frontier",
          },
        },
      },
    });
    const { models } = parseGrokModelsCache(raw);
    expect(models).toEqual([
      {
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "frontier",
      },
    ]);
  });

  it("readGrokModels fails soft on missing cache", () => {
    const result = readGrokModels("/no/such/home", () => undefined);
    expect(result).toMatchObject({ models: [], source: "empty" });
  });

  it("parseCodexDebugModels accepts JSON and line forms", () => {
    const json = parseCodexDebugModels(
      JSON.stringify([
        { id: "gpt-5.6-luna", efforts: ["low", "medium", "high", "ultra"] },
      ]),
    );
    expect(json.models[0]).toMatchObject({
      id: "gpt-5.6-luna",
      efforts: ["low", "medium", "high", "ultra"],
    });

    const lines = parseCodexDebugModels(
      "gpt-5.4-mini low medium high\ngpt-5.6-sol low high ultra\n",
    );
    expect(lines.models).toHaveLength(2);
    expect(lines.models[0]?.efforts).toEqual(["low", "medium", "high"]);
  });

  it("enumerateCodexModels stubs empty without a runner", async () => {
    const empty = await enumerateCodexModels();
    expect(empty.source).toBe("empty");
    const full = await enumerateCodexModels(async () =>
      JSON.stringify([{ id: "gpt-5.4-mini", efforts: ["low"] }]),
    );
    expect(full.source).toBe("command");
    expect(full.models[0]?.id).toBe("gpt-5.4-mini");
  });

  it("parseHermesProfileList skips header and diamond marker", () => {
    // Fixed-width columns separated by 2+ spaces (hermes profile list, no --json).
    const stdout = [
      "Profile          Model         Status    Gateway   Notes",
      "────────────────────────────────────────────────────────",
      "◆default         gpt-5.5       running   —         —",
      " profile-13          gpt-5.4-mini  stopped   profile-13    —",
    ].join("\n");
    const profiles = parseHermesProfileList(stdout);
    expect(profiles).toEqual([
      { name: "default", model: "gpt-5.5", gateway: "running" },
      { name: "profile-13", model: "gpt-5.4-mini", gateway: "stopped" },
    ]);
  });

  it("enumerateHermesProfiles uses injectable runner", async () => {
    const empty = await enumerateHermesProfiles();
    expect(empty.source).toBe("empty");
    const full = await enumerateHermesProfiles(
      async () => "default    gpt-5.5    running",
    );
    expect(full.profiles[0]?.name).toBe("default");
    expect(full.source).toBe("command");
  });

  it("effortsFor prefers model-carried list then template defaults", () => {
    expect(effortsFor("hermes")).toEqual([]);
    expect(effortsFor("grok")).toEqual(["high", "medium", "low"]);
    expect(
      effortsFor("codex", {
        id: "gpt-5.6-luna",
        label: "luna",
        efforts: ["low", "ultra"],
      }),
    ).toEqual(["low", "ultra"]);
  });
});
