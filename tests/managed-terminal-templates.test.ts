import { describe, expect, it } from "vitest";
import {
  AGY_TEMPLATE,
  AMP_TEMPLATE,
  APPEARANCE_PREFERENCE_FLAGS,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_TEMPLATE,
  CODEX_TEMPLATE,
  CURSOR_TEMPLATE,
  DEVIN_TEMPLATE,
  FX_TEMPLATE,
  GROK_TEMPLATE,
  HERMES_TEMPLATE,
  HARNESS_IDS,
  KIMI_TEMPLATE,
  MANAGED_TERMINAL_TEMPLATES,
  MUSE_TEMPLATE,
  OMP_TEMPLATE,
  PI_TEMPLATE,
  PRIME_AGENT_TEMPLATE,
  SPAWN_ENV_SCRUB,
  SPAWN_ENV_SCRUB_PREFIXES,
  allTemplates,
  isHarnessId,
  isSandboxGatedPermissionMode,
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
  parseAgyModelsList,
  parseClaudeModelCache,
  parseCodexDebugModels,
  parseGrokModelsCache,
  parseHermesProfileList,
  parseHermesProviderModelsCache,
  readClaudeModels,
  readGrokModels,
  readHermesModels,
} from "../src/main/vellum-command/term/templates/enumerate-models";
import {
  HARNESS_KIMI_ENABLED,
  HARNESS_MUSE_ENABLED,
  HARNESS_PRIME_AGENT_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  managedHarnessEnabled,
} from "../src/shared/features";

describe("managed-terminal templates (data)", () => {
  const ALL_HARNESSES = [
    "claude",
    "codex",
    "grok",
    "hermes",
    "pi",
    "prime-agent",
    "kimi",
    "muse",
    "devin",
    "cursor",
    "agy",
    "amp",
    "fx",
    "omp",
  ] as const;

  it("exports exactly the managed harnesses", () => {
    expect(HARNESS_IDS).toEqual([...ALL_HARNESSES]);
    const expected = ALL_HARNESSES.filter((h) => managedHarnessEnabled(h));
    expect(allTemplates().map((template) => template.harness)).toEqual([
      ...expected,
    ]);
    // Ship defaults: Kimi/Muse off, Prime Agent on (unless overridden).
    if (!HERMES_INTEGRATION_ENABLED) {
      expect(expected).not.toContain("hermes");
    }
    if (!HARNESS_KIMI_ENABLED) expect(expected).not.toContain("kimi");
    if (!HARNESS_MUSE_ENABLED) expect(expected).not.toContain("muse");
    if (!HARNESS_PRIME_AGENT_ENABLED) {
      expect(expected).not.toContain("prime-agent");
    }
    for (const id of ALL_HARNESSES) {
      expect(isHarnessId(id)).toBe(true);
      expect(templateFor(id)).toBe(MANAGED_TERMINAL_TEMPLATES[id]);
      expect(MANAGED_TERMINAL_TEMPLATES[id].harness).toBe(id);
    }
    expect(isHarnessId("openclaw")).toBe(false);
  });

  it("no template prefix carries an appearance or preference flag", () => {
    // A seat Vellum Command starts must present the same experience as the harness
    // started by hand. These flags have a home in the harness's own config, so
    // one here would override the operator's file for factory seats only —
    // which is exactly how grok ended up rendering scrollback-native with the
    // wrong theme while plain `grok` rendered their configured TUI.
    for (const id of ALL_HARNESSES) {
      const prefix = MANAGED_TERMINAL_TEMPLATES[id].argvSpec.prefix;
      for (const flag of APPEARANCE_PREFERENCE_FLAGS) {
        expect(prefix, `${id} prefix must not carry ${flag}`).not.toContain(flag);
      }
    }
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
    // Codex captures its thread id and `codexSessionExists` proves it; the old
    // "unavailable" badge described a gap that was already closed.
    expect(CODEX_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    // Hermes proves session ids from ~/.hermes/state.db; the retired jsonl
    // tree was the only thing the old "unavailable" badge described.
    expect(HERMES_TEMPLATE.capabilityBadges.sessionId).toBe("capture");
    expect(HERMES_TEMPLATE.capabilityBadges.effortAtSpawn).toBe(true);
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
      expect.arrayContaining(["capture session", "doctrine at creation"]),
    );
    expect(CODEX_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain(
      "no cold resume",
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["capture session"]),
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels.join(" ")).not.toContain(
      "no cold resume",
    );
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

  it("describes shipped Prime Agent 0.9.4 capabilities honestly", () => {
    expect(PRIME_AGENT_TEMPLATE.probedVersion).toBe("0.9.4");
    expect(PRIME_AGENT_TEMPLATE.displayName).toBe("Prime Agent");
    expect(PRIME_AGENT_TEMPLATE.injectionSpec.tier).toBe("A");
    expect(PRIME_AGENT_TEMPLATE.argvSpec).toMatchObject({
      binary: "prime-agent",
      prefix: [],
      promptMode: "positional",
      modelFlag: "--model",
      effortFlag: "--thinking",
      resumeMode: "flag",
      resumeFlag: "-r",
      systemPromptFlag: "--append-system-prompt",
      resumeReinjection: "unprobed",
    });
    expect(PRIME_AGENT_TEMPLATE.efforts).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(PRIME_AGENT_TEMPLATE.capabilityBadges).toMatchObject({
      hooks: true,
      effortAtSpawn: true,
      sessionId: "capture",
      remote: true,
      stateFeed: "built-in reporter → OSC9/133 + grid",
      attentionSource: "built-in blocked events → grid overlays",
    });
    expect(PRIME_AGENT_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining([
        "built-in reporter",
        "zero-write hooks",
        "capture session",
        "no permission enum",
      ]),
    );
  });

  it("shares the mandatory spawn env scrub list", () => {
    expect(SPAWN_ENV_SCRUB).toEqual([
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "PI_CODING_AGENT",
      "NO_COLOR",
      "FORCE_COLOR",
      "CURSOR_CONVERSATION_ID",
      "CURSOR_AGENT_STORE_FILES_DIR",
      "CURSOR_AGENT_STORE_SHARED_PATHS",
      // fx reads its spawn dials from the environment, so a nested fx seat
      // would inherit the parent session's model, permission mode and step
      // limit — and its recording knobs.
      "FX_MODEL",
      "FX_PERMISSION_MODE",
      "FX_MAX_AGENT_STEPS",
      "DEVIN_MODEL",
      "DEVIN_PERMISSION_MODE",
      "DEVIN_SANDBOX",
      "FX_RECORD",
      "FX_RECORD_INPUT",
      // Oh My Pi shares the pi-family env namespace.
      "OMP_PROFILE",
      "PI_CODING_AGENT_DIR",
      "PI_NO_PTY",
      "PI_SMOL_MODEL",
      "PI_SLOW_MODEL",
      "PI_PLAN_MODEL",
    ]);
    expect(SPAWN_ENV_SCRUB_PREFIXES).toEqual(["PRIME_AGENT_INTERNAL_"]);
    for (const t of allTemplates()) {
      expect(t.envSpec.scrub).toEqual(SPAWN_ENV_SCRUB);
    }
  });

  it("describes shipped Devin 3000.10.21 capabilities honestly", () => {
    expect(DEVIN_TEMPLATE.probedVersion).toBe("3000.10.21");
    expect(DEVIN_TEMPLATE.displayName).toBe("Devin");
    expect(DEVIN_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(DEVIN_TEMPLATE.injectionSpec.flags).toEqual([]);
    expect(DEVIN_TEMPLATE.injectionSpec.description).toBe(
      "No system-prompt flag — doctrine delivered as the first typed message",
    );
    expect(DEVIN_TEMPLATE.injectionSpec.description).not.toContain(
      "--agent-config",
    );
    expect(DEVIN_TEMPLATE.argvSpec).toMatchObject({
      binary: "devin",
      promptMode: "positional",
      promptSeparator: "--",
      modelFlag: "--model",
      permissionModeFlag: "--permission-mode",
      resumeMode: "flag",
      resumeFlag: "-r",
      resumeReinjection: "unprobed",
    });
    expect(DEVIN_TEMPLATE.defaultPermissionMode).toBe("normal");
    expect(DEVIN_TEMPLATE.efforts).toEqual([]);
    expect(isSandboxGatedPermissionMode("autonomous")).toBe(true);
    expect(isSandboxGatedPermissionMode("normal")).toBe(false);
    expect(isSandboxGatedPermissionMode("auto")).toBe(false);
  });

  it("describes shipped Cursor Agent 2026.09.10-fd3934a capabilities honestly", () => {
    expect(CURSOR_TEMPLATE.probedVersion).toBe("2026.09.10-fd3934a");
    expect(CURSOR_TEMPLATE.displayName).toBe("Cursor Agent");
    expect(CURSOR_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(CURSOR_TEMPLATE.argvSpec).toMatchObject({
      binary: "agent",
      prefix: ["--trust"],
      promptMode: "positional",
      modelFlag: "--model",
      effortModelBracketKey: "effort",
      permissionModeFlag: "--yolo",
      sessionIdFlag: "--new-session-id",
      resumeMode: "flag",
      resumeFlag: "--resume",
      resumeReinjection: "re-pass",
    });
    expect(CURSOR_TEMPLATE.argvSpec.effortFlag).toBeUndefined();
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
    expect(CURSOR_TEMPLATE.capabilityBadges.sessionId).toBe("pin");
    expect(CURSOR_TEMPLATE.capabilityBadges.effortAtSpawn).toBe(true);
  });

  it("uses hermes chat --tui (not headless -z)", () => {
    expect(HERMES_TEMPLATE.argvSpec.binary).toBe("hermes");
    expect(HERMES_TEMPLATE.argvSpec.prefix).toEqual(["chat", "--tui"]);
    expect(HERMES_TEMPLATE.argvSpec.promptMode).toBe("flag-q");
    expect(HERMES_TEMPLATE.probedVersion).toBe("0.21.0");
    expect(HERMES_TEMPLATE.argvSpec.effortFlag).toBe("--reasoning");
    expect(HERMES_TEMPLATE.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(HERMES_TEMPLATE.capabilityBadges.labels).toEqual(
      expect.arrayContaining(["effort", "capture session"]),
    );
    expect(HERMES_TEMPLATE.capabilityBadges.labels).not.toContain("no effort flag");
  });
});

describe("scrubSpawnEnv + buildSpawnEnv", () => {
  it("strips exact nested-session markers", () => {
    const scrubbed = scrubSpawnEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "yes",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      PI_CODING_AGENT: "true",
      NO_COLOR: "1",
      VELLUM_COMMAND_TOKEN: "tok",
      EMPTY: undefined,
    });
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      VELLUM_COMMAND_TOKEN: "tok",
    });
  });

  it("strips every Prime Agent internal prefix, including unknown future keys", () => {
    const scrubbed = scrubSpawnEnv({
      PATH: "/usr/bin",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
      PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "secret",
      PRIME_AGENT_INTERNAL_FUTURE_ROLE: "future",
      PRIME_AGENT_INTERNAL: "near-miss",
      PRIME_AGENT_PUBLIC_SETTING: "keep",
    });
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      PRIME_AGENT_INTERNAL: "near-miss",
      PRIME_AGENT_PUBLIC_SETTING: "keep",
    });
  });

  it("merges inject after scrub and refuses to reintroduce exact or prefix keys", () => {
    const env = buildSpawnEnv(
      {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        PI_CODING_AGENT: "true",
        PRIME_AGENT_INTERNAL_DAEMON_WORKER: "1",
        HOME: "/home/op",
      },
      {
        VELLUM_COMMAND_SOCKET: "/tmp/work.sock",
        VELLUM_COMMAND_TOKEN: "t",
        CLAUDECODE: "evil",
        PI_CODING_AGENT: "evil",
        PRIME_AGENT_INTERNAL_DAEMON_WORKER: "evil",
        PRIME_AGENT_INTERNAL_NEW_AUTHORITY: "evil",
        PATH: "/opt/vellum/bin:/usr/bin",
      },
    );
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PI_CODING_AGENT).toBeUndefined();
    expect(env.PRIME_AGENT_INTERNAL_DAEMON_WORKER).toBeUndefined();
    expect(env.PRIME_AGENT_INTERNAL_NEW_AUTHORITY).toBeUndefined();
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.PATH).toBe("/opt/vellum/bin:/usr/bin");
    expect(env.VELLUM_COMMAND_SOCKET).toBe("/tmp/work.sock");
    expect(env.HOME).toBe("/home/op");
  });

  it("strips ambient Devin spawn dials", () => {
    const scrubbed = scrubSpawnEnv({
      PATH: "/usr/bin",
      DEVIN_MODEL: "claude-opus-5-high",
      DEVIN_PERMISSION_MODE: "autonomous",
      DEVIN_SANDBOX: "1",
      HOME: "/home/op",
    });
    expect(scrubbed).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/op",
    });
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
        systemPrompt: "call vellum-command onboard",
        prompt: "start the task",
        cwd: "/repo",
        env: { VELLUM_COMMAND_TOKEN: "t" },
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
      "call vellum-command onboard",
      "start the task",
    ]);
    expect(launch.env?.VELLUM_COMMAND_TOKEN).toBe("t");
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
    // Snapshot-off only rides a resume that also re-passes doctrine.
    expect(launch.argv).not.toContain("--system-prompt-snapshot");
  });

  it("claude resume re-passing doctrine turns system-prompt-snapshot off", () => {
    // 2.1.267+ records --append-system-prompt on the first request (default
    // snapshot on). A later different append is ignored unless snapshot is
    // off. Live 2.1.268 print-mode canary: ALPHA create → BETA resume (no
    // off) stayed ALPHA; GAMMA resume with off returned GAMMA.
    expect(CLAUDE_TEMPLATE.probedVersion).toBe("2.1.268");
    expect(CLAUDE_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
    expect(CLAUDE_TEMPLATE.argvSpec.resumeReinjectionArgv).toEqual([
      "--system-prompt-snapshot",
      "off",
    ]);
    expect(CLAUDE_TEMPLATE.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(CLAUDE_TEMPLATE.defaultPermissionMode).toBe("default");
    const launch = resolveManagedLaunch(
      "claude",
      {
        resumeId: "abc",
        systemPrompt: "new doctrine",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "claude",
      "--resume",
      "abc",
      "--permission-mode",
      "default",
      "--append-system-prompt",
      "new doctrine",
      "--system-prompt-snapshot",
      "off",
    ]);
  });

  it("codex floors include max from the 0.154.0 debug-models union", () => {
    expect(CODEX_TEMPLATE.probedVersion).toBe("0.154.0");
    expect(CODEX_TEMPLATE.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(effortsFor("codex")).toEqual(CODEX_TEMPLATE.efforts);
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
    // Appearance is the operator's harness config, never a spawn flag.
    expect(GROK_TEMPLATE.argvSpec.prefix).toEqual([]);
    expect(GROK_TEMPLATE.probedVersion).toBe("1.0.25");
    expect(GROK_TEMPLATE.argvSpec.resumeReinjection).toBe("frozen");
    expect(GROK_TEMPLATE.efforts).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("grok resume drops --rules because 1.0.25 freezes doctrine at create", () => {
    // Live canary: pin --rules ALPHA, then -r --rules BETA answered ALPHA.
    const resume = resolveManagedLaunch(
      "grok",
      {
        resumeId: "00000000-0000-4000-8000-00000000a33d",
        systemPrompt: "BETA_RULES_ONLY",
        effort: "xhigh",
      },
      bareAmbient,
    );
    expect(resume.argv).toEqual([
      "grok",
      "-r",
      "00000000-0000-4000-8000-00000000a33d",
      "--reasoning-effort",
      "xhigh",
      "--permission-mode",
      "default",
    ]);
    expect(resume.argv).not.toContain("--rules");
    expect(resume.argv).not.toContain("BETA_RULES_ONLY");
  });

  it("grok prefers --rules when systemPrompt is set without agentFile", () => {
    const launch = resolveManagedLaunch(
      "grok",
      { systemPrompt: "doctrine text", permissionMode: "default" },
      bareAmbient,
    );
    const argv = launch.argv ?? [];
    expect(argv[0]).toBe("grok");
    expect(argv).not.toContain("--minimal");
    expect(argv).not.toContain("--no-alt-screen");
    expect(argv).toContain("--rules");
    expect(argv).toContain("doctrine text");
    expect(argv).not.toContain("--agent");
  });

  it("amp: launches --no-ide and resumes the exact thread by id", () => {
    // Both shapes verified against amp 0.0.1787664850 in a real PTY.
    // 0.0.1789113641 still emits `--no-ide` + named `threads continue <T-id>`.
    const fresh = resolveManagedLaunch(
      "amp",
      { resumeId: "T-01a03989-71a6-733b-ac4c-76f54969cb55", mode: "low" },
      bareAmbient,
    );
    expect(fresh.argv).toEqual([
      "amp",
      "--no-ide",
      "threads",
      "continue",
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
      "-m",
      "low",
    ]);
    // Amp exposes no model flag and no independent effort — the one dial is
    // the named mode, and it must never be reported as either of the others.
    expect(AMP_TEMPLATE.argvSpec.modelFlag).toBeUndefined();
    expect(AMP_TEMPLATE.argvSpec.effortFlag).toBeUndefined();
    expect(AMP_TEMPLATE.efforts).toEqual([]);
    expect(AMP_TEMPLATE.modes).toEqual(["low", "medium", "high", "ultra"]);
    expect(AMP_TEMPLATE.capabilityBadges.sessionId).toBe("provision");
    expect(AMP_TEMPLATE.injectionSpec.tier).toBe("B");
    expect(AMP_TEMPLATE.injectionSpec.flags).toEqual([]);
    expect(AMP_TEMPLATE.probedVersion).toBe("0.0.1789113641");
  });

  it("amp: no permission-mode override is ever spawned", () => {
    const launch = resolveManagedLaunch(
      "amp",
      { resumeId: "T-01a03989-71a6-733b-ac4c-76f54969cb55" },
      bareAmbient,
    );
    const argv = launch.argv ?? [];
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(AMP_TEMPLATE.defaultPermissionMode).toBeUndefined();
  });

  it("fx: env dials, named --resume, no argv permission flags", () => {
    expect(FX_TEMPLATE.probedVersion).toBe("0.0.7");
    expect(FX_TEMPLATE.argvSpec.resumeReinjection).toBe("unprobed");
    expect(FX_TEMPLATE.argvSpec.modelFlag).toBeUndefined();
    expect(FX_TEMPLATE.argvSpec.permissionModeFlag).toBeUndefined();
    expect(FX_TEMPLATE.defaultPermissionMode).toBeUndefined();
    const launch = resolveManagedLaunch(
      "fx",
      {
        model: "anthropic/claude-opus-5",
        permissionMode: "ask",
        resumeId: "AbC_-0123xyz",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual(["fx", "--resume", "AbC_-0123xyz"]);
    expect(launch.argv).not.toContain("--full-access");
    expect(launch.argv).not.toContain("--yolo");
    expect(launch.env?.FX_MODEL).toBe("anthropic/claude-opus-5");
    expect(launch.env?.FX_PERMISSION_MODE).toBe("ask");
  });

  it("omp: last-write-wins append, thinking, named --resume", () => {
    expect(OMP_TEMPLATE.probedVersion).toBe("18.1.16");
    expect(OMP_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
    expect(OMP_TEMPLATE.injectionSpec.description).not.toMatch(/repeatable/i);
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
    const launch = resolveManagedLaunch(
      "omp",
      {
        model: "opus",
        effort: "high",
        permissionMode: "write",
        systemPrompt: "seat doctrine",
        prompt: "get to work",
      },
      bareAmbient,
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
    expect(
      launch.argv?.filter((token) => token === "--append-system-prompt"),
    ).toHaveLength(1);
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

  it("hermes emits --reasoning at spawn and re-passes it on resume", () => {
    const launch = resolveManagedLaunch(
      "hermes",
      {
        profile: "default",
        model: "gpt-5.4-mini",
        effort: "high",
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
      "--reasoning",
      "high",
      "-q",
      "Reply with OK",
    ]);
    const resume = resolveManagedLaunch(
      "hermes",
      {
        resumeId: "20000101_120001_abc001",
        model: "gpt-5.4-mini",
        effort: "xhigh",
      },
      bareAmbient,
    );
    expect(resume.argv).toEqual([
      "hermes",
      "chat",
      "--tui",
      "-r",
      "20000101_120001_abc001",
      "-m",
      "gpt-5.4-mini",
      "--reasoning",
      "xhigh",
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
  it("pi: model, thinking effort, session pin, append-system-prompt, positional prompt", () => {
    expect(PI_TEMPLATE.probedVersion).toBe("0.85.1");
    expect(PI_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
    expect(PI_TEMPLATE.efforts).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    const launch = resolveManagedLaunch(
      "pi",
      {
        model: "sonnet",
        effort: "high",
        sessionId: "019fd402-9e75-75e2-bca4-18bff1f2d5cc",
        systemPrompt: "call vellum-command onboard",
        prompt: "start the task",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "pi",
      "--model",
      "sonnet",
      "--thinking",
      "high",
      "--session-id",
      "019fd402-9e75-75e2-bca4-18bff1f2d5cc",
      "--append-system-prompt",
      "call vellum-command onboard",
      "start the task",
    ]);
  });

  it("pi resume is --session (not -r, which opens the interactive picker)", () => {
    const launch = resolveManagedLaunch(
      "pi",
      { resumeId: "019fd402-9e75-75e2-bca4-18bff1f2d5cc", effort: "high" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "pi",
      "--session",
      "019fd402-9e75-75e2-bca4-18bff1f2d5cc",
      "--thinking",
      "high",
    ]);
  });

  it("pi has no permission-mode flag (--approve is project trust, not an enum)", () => {
    const launch = resolveManagedLaunch("pi", { permissionMode: "yolo" }, bareAmbient);
    expect(launch.argv).toEqual(["pi"]);
  });

  it("prime-agent: model, thinking effort, append-system-prompt, positional prompt", () => {
    const launch = resolveManagedLaunch(
      "prime-agent",
      {
        model: "gpt-5.5",
        effort: "medium",
        systemPrompt: "doctrine text",
        prompt: "proceed",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "prime-agent",
      "--model",
      "gpt-5.5",
      "--thinking",
      "medium",
      "--append-system-prompt",
      "doctrine text",
      "proceed",
    ]);
    // The per-binding daemon socket is runtime state, never authorial argv.
    expect(launch.argv).not.toContain("--daemon-socket");
  });

  it("prime-agent resume re-passes flags via -r", () => {
    const launch = resolveManagedLaunch(
      "prime-agent",
      { resumeId: "8f3c2a1e-b4d5-4e6f-9a0b-1c2d3e4f5a6b", model: "gpt-5.5" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "prime-agent",
      "-r",
      "8f3c2a1e-b4d5-4e6f-9a0b-1c2d3e4f5a6b",
      "--model",
      "gpt-5.5",
    ]);
  });

  it("prime-agent has no permission-mode flag (--autonomous is unattended mode, not an enum)", () => {
    const launch = resolveManagedLaunch(
      "prime-agent",
      { permissionMode: "yolo" },
      bareAmbient,
    );
    expect(launch.argv).toEqual(["prime-agent"]);
  });

  it("kimi promptMode none drops the argv prompt entirely", () => {
    const launch = resolveManagedLaunch("kimi", { prompt: "hello" }, bareAmbient);
    expect(launch.argv).toEqual(["kimi"]);
    expect((launch.argv ?? []).join(" ")).not.toContain("hello");
  });

  it("kimi: -m model and bare --yolo only when enabled", () => {
    const on = resolveManagedLaunch(
      "kimi",
      { model: "kimi-k3", permissionMode: "yolo" },
      bareAmbient,
    );
    expect(on.argv).toEqual(["kimi", "-m", "kimi-k3", "--yolo"]);
    const off = resolveManagedLaunch(
      "kimi",
      { model: "kimi-k3", permissionMode: "off" },
      bareAmbient,
    );
    expect(off.argv).toEqual(["kimi", "-m", "kimi-k3"]);
    expect(off.argv).not.toContain("--yolo");
  });

  it("kimi resume re-passes -m via -S", () => {
    const launch = resolveManagedLaunch(
      "kimi",
      { resumeId: "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc", model: "kimi-k3" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "kimi",
      "-S",
      "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
      "-m",
      "kimi-k3",
    ]);
  });

  it("kimi 0.34.0: resumeReinjection frozen never builds --agent-file beside -S", () => {
    // Live 0.34.0 exits 1: Cannot combine --agent/--agent-file with
    // --session/--continue. The pair must never be on argv.
    expect(KIMI_TEMPLATE.probedVersion).toBe("0.34.0");
    expect(KIMI_TEMPLATE.argvSpec.resumeReinjection).toBe("frozen");
    expect(KIMI_TEMPLATE.argvSpec.agentFlag).toBe("--agent-file");
    expect(KIMI_TEMPLATE.argvSpec.resumeFlag).toBe("-S");
    const resume = resolveManagedLaunch(
      "kimi",
      {
        resumeId: "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
        agentFile: "/tmp/agent.md",
        systemPrompt: "DOCTRINE",
      },
      bareAmbient,
    );
    expect(resume.argv).toEqual([
      "kimi",
      "-S",
      "session_c2da0425-9e75-75e2-bca4-18bff1f2d5cc",
    ]);
    expect(resume.argv).toContain("-S");
    expect(resume.argv).not.toContain("--agent-file");
    expect(resume.argv).not.toContain("/tmp/agent.md");
  });

  it("muse: model, reasoning effort, bare --yolo, positional prompt", () => {
    expect(MUSE_TEMPLATE.probedVersion).toBe("1.1.1-R2514.1");
    expect(MUSE_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
    expect(MUSE_TEMPLATE.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    const launch = resolveManagedLaunch(
      "muse",
      {
        model: "muse-1",
        effort: "high",
        permissionMode: "yolo",
        prompt: "do the thing",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "muse",
      "--model",
      "muse-1",
      "--reasoning-effort",
      "high",
      "--yolo",
      "do the thing",
    ]);
  });

  it("muse resume is a subcommand and re-passes flags", () => {
    const launch = resolveManagedLaunch(
      "muse",
      { resumeId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", effort: "low" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "muse",
      "resume",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "--reasoning-effort",
      "low",
    ]);
  });

  it("muse omits --yolo by default", () => {
    const launch = resolveManagedLaunch("muse", { prompt: "hi" }, bareAmbient);
    expect(launch.argv).toEqual(["muse", "hi"]);
    expect(launch.argv).not.toContain("--yolo");
  });

  it("devin: --permission-mode default and -- separator before positional prompt", () => {
    const launch = resolveManagedLaunch("devin", { prompt: "make it" }, bareAmbient);
    expect(launch.argv).toEqual([
      "devin",
      "--permission-mode",
      "normal",
      "--",
      "make it",
    ]);
    const bare = resolveManagedLaunch("devin", {}, bareAmbient);
    expect(bare.argv).toEqual(["devin", "--permission-mode", "normal"]);
    expect(bare.argv).not.toContain("--sandbox");
  });

  it("devin never emits autonomous without --sandbox", () => {
    const launch = resolveManagedLaunch(
      "devin",
      { permissionMode: "autonomous", prompt: "make it" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "devin",
      "--sandbox",
      "--permission-mode",
      "autonomous",
      "--",
      "make it",
    ]);
    const resume = resolveManagedLaunch(
      "devin",
      { resumeId: "even-birthday", permissionMode: "autonomous" },
      bareAmbient,
    );
    expect(resume.argv).toEqual([
      "devin",
      "-r",
      "even-birthday",
      "--sandbox",
      "--permission-mode",
      "autonomous",
    ]);
  });

  it("cursor: --trust prefix, positional prompt, --model, bare --yolo", () => {
    const launch = resolveManagedLaunch(
      "cursor",
      { prompt: "fix tests", model: "auto", permissionMode: "yolo" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "agent",
      "--trust",
      "--model",
      "auto",
      "--yolo",
      "fix tests",
    ]);
    const bare = resolveManagedLaunch("cursor", {}, bareAmbient);
    expect(bare.argv).toEqual(["agent", "--trust"]);
  });

  it("cursor resume re-passes --model via --resume <id>", () => {
    const launch = resolveManagedLaunch(
      "cursor",
      { resumeId: "chat-abc", model: "composer-2.5" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "agent",
      "--trust",
      "--resume",
      "chat-abc",
      "--model",
      "composer-2.5",
    ]);
    expect(launch.argv).not.toContain("--continue");
  });

  it("cursor model+effort emits a hyphenated catalog slug, not [effort=]", () => {
    const launch = resolveManagedLaunch(
      "cursor",
      { model: "claude-opus-4-8", effort: "high", prompt: "ok" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "agent",
      "--trust",
      "--model",
      "claude-opus-4-8-high",
      "ok",
    ]);
    expect(launch.argv?.join(" ")).not.toContain("[effort=");
    const bracketed = resolveManagedLaunch(
      "cursor",
      { model: "composer-2.5[fast=false]" },
      bareAmbient,
    );
    expect(bracketed.argv).toContain("composer-2.5[fast=false]");
  });

  it("devin resume re-passes --model and default permission via -r", () => {
    const launch = resolveManagedLaunch(
      "devin",
      { resumeId: "sample-session", model: "devin-3" },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "devin",
      "-r",
      "sample-session",
      "--model",
      "devin-3",
      "--permission-mode",
      "normal",
    ]);
  });

  it("agy: model, effort, promptMode flag-i, permissionMode, agent", () => {
    expect(AGY_TEMPLATE.probedVersion).toBe("1.2.1");
    expect(AGY_TEMPLATE.argvSpec.resumeReinjection).toBe("re-pass");
    expect(AGY_TEMPLATE.capabilityBadges.attentionSource).toBe(
      "permission prompt (Run this command?, Allow access to this URL?, Allow calling this tool?)",
    );
    const launch = resolveManagedLaunch(
      "agy",
      {
        model: "gemini-3.7-flash-high",
        effort: "high",
        prompt: "analyze code",
        permissionMode: "yolo",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "agy",
      "--model",
      "gemini-3.7-flash-high",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
      "-i",
      "analyze code",
    ]);
  });

  it("agy resume re-passes flags via --conversation <id>", () => {
    const launch = resolveManagedLaunch(
      "agy",
      {
        resumeId: "a102d6df-ee76-4418-8983-5bc5fe261153",
        model: "gemini-3.7-flash-high",
        effort: "medium",
      },
      bareAmbient,
    );
    expect(launch.argv).toEqual([
      "agy",
      "--conversation",
      "a102d6df-ee76-4418-8983-5bc5fe261153",
      "--model",
      "gemini-3.7-flash-high",
      "--effort",
      "medium",
    ]);
    expect(launch.argv).not.toContain("--continue");
    expect(launch.argv).not.toContain("-c");
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
    // Cache label "Fable" covers the "fable" alias — do not list both.
    expect(models.map((m) => m.id)).not.toContain("fable");
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(
        CLAUDE_MODEL_ALIASES.filter((id) => id !== "fable"),
      ),
    );
  });

  it("parseClaudeModelCache keeps aliases when cache is empty", () => {
    const { models } = parseClaudeModelCache("{}");
    expect(models.map((m) => m.id)).toEqual([...CLAUDE_MODEL_ALIASES]);
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

    const live = parseCodexDebugModels(
      JSON.stringify({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6-Astra",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast" },
              { effort: "medium", description: "Balanced" },
              { effort: "high", description: "Deep" },
              { effort: "xhigh", description: "Extra" },
              { effort: "max", description: "Maximum" },
              { effort: "ultra", description: "Delegated" },
            ],
          },
          {
            slug: "gpt-5.5",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
          },
        ],
      }),
    );
    expect(live.models[0]).toMatchObject({
      id: "gpt-6-astra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(live.models[1]?.efforts).toEqual(["low", "medium", "high", "xhigh"]);

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
      " profile-13      gpt-5.4-mini  stopped   profile-13 —",
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

  it("parseHermesProviderModelsCache flattens unique provider model ids", () => {
    const raw = JSON.stringify({
      "openai-codex": { fp: "a", at: 1, models: ["gpt-5.5", "gpt-5.6-sol"] },
      anthropic: { fp: "b", at: 2, models: ["claude-fable-5", "gpt-5.5"] },
      broken: { models: "not-an-array" },
      stale: { models: ["https://example.com/404", "ok-model"] },
    });
    const { models, error } = parseHermesProviderModelsCache(raw);
    expect(error).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual([
      "claude-fable-5",
      "gpt-5.5",
      "gpt-5.6-sol",
      "ok-model",
    ]);
    expect(models.find((m) => m.id === "gpt-5.5")?.description).toBe("openai-codex");
  });

  it("readHermesModels fails soft on missing cache", () => {
    const result = readHermesModels("/no/such/home", () => undefined);
    expect(result).toMatchObject({ models: [], source: "empty" });
    expect(result.error).toMatch(/missing/);
  });

  it("readHermesModels uses injectable reader", () => {
    const raw = JSON.stringify({
      "openai-codex": { models: ["gpt-5.5"] },
    });
    const result = readHermesModels("/home/op", (path) => {
      expect(path).toBe("/home/op/.hermes/provider_models_cache.json");
      return raw;
    });
    expect(result.source).toBe("cache");
    expect(result.models).toEqual([
      { id: "gpt-5.5", label: "gpt-5.5", description: "openai-codex" },
    ]);
  });

  it("effortsFor prefers model-carried list then template defaults", () => {
    expect(effortsFor("hermes")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(effortsFor("grok")).toEqual(["xhigh", "high", "medium", "low"]);
    expect(effortsFor("cursor")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "extra-high",
      "max",
    ]);
    expect(
      effortsFor("codex", {
        id: "gpt-5.6-luna",
        label: "luna",
        efforts: ["low", "ultra"],
      }),
    ).toEqual(["low", "ultra"]);
  });

  it("parseAgyModelsList parses tab-separated agy models output", () => {
    const stdout = [
      "Fetching available models...",
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
      "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    ].join("\n");
    const { models, error } = parseAgyModelsList(stdout);
    expect(error).toBeUndefined();
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("parseAgyModelsList handles ANSI escapes, middots, duplicate IDs, single-token lines, and blank lines", () => {
    const stdout = [
      "\x1b[1mFetching available models...\x1b[0m",
      "",
      "\x1b[32mgemini-3.7-flash-high\x1b[0m\tGemini 3.7 Flash \u00B7 High",
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High Duplicate)",
      "custom-standalone-model",
      "  ",
      "\r\n",
    ].join("\n");
    const { models, error } = parseAgyModelsList(stdout);
    expect(error).toBeUndefined();
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash , High" },
      { id: "custom-standalone-model", label: "custom-standalone-model" },
    ]);
  });
});


