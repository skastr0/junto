/**
 * What each harness reports and accepts today, through the PTY stream only:
 * rendered screen text and titles, in-band OSC 7501 reports, the PTY child's
 * exit, and keystrokes typed into it. One record per harness, every signal
 * and command key written out, "none" included. Design:
 * `docs/harness-domain.md`.
 *
 * Every level that is not "none" names its ground: a rule in the harness's
 * screen rule pack (`src/main/junto/term/agent-state/rules/`), a template
 * table in `managed-terminal-templates.ts`, or a code witness. A rule ground
 * says the pack recognizes that chrome today; step 2 of the build order makes
 * the same rule emit the signal. Tests check every ground resolves.
 *
 * Claude and Agy queue a mid-turn Enter ("press up to edit queued messages")
 * and no steering key is known, so they declare queue, not steer.
 *
 * Interrupt is typed only where a rule shows the harness's own Ctrl+C cancel
 * hint: the drive's Ctrl+C means something else on other harnesses (Amp opens
 * a quit menu, Claude and Devin interrupt on Esc).
 */
import {
  type CommandCapability,
  type CommandSupport,
  type HarnessCapabilities,
  type HarnessSignalKind,
  type SignalSupport,
} from "./harness-domain";
import { type HarnessId, isHarnessId } from "./managed-terminal-templates";

/** Why a declared level is not "none". */
export type CapabilityGround =
  /** A rule id in this harness's screen rule pack. */
  | { readonly rule: string }
  /** A per-harness template fact. */
  | { readonly template: "followUp.steering" | "followUp.queue" | "argvSpec.resumeMode" }
  /** Shared code that witnesses the capability, as `file#symbol`. */
  | { readonly code: string };

type Grounded<S> = S extends { readonly level: "none" }
  ? S
  : S & { readonly grounds: readonly CapabilityGround[] };

export type HarnessCapabilityDeclaration = {
  readonly signals: Readonly<Record<HarnessSignalKind, Grounded<SignalSupport>>>;
  readonly commands: Readonly<Record<CommandCapability, Grounded<CommandSupport>>>;
};

const NONE = { level: "none" } as const;

const screen = (...rules: readonly string[]): Grounded<SignalSupport> => ({
  level: "screen",
  channel: "screen",
  grounds: rules.map((rule) => ({ rule })),
});

/**
 * Reported in-band by the Program Status Protocol. Declared only for reports
 * captured from the real binary (`CAPTURED` in `tests/program-status.test.ts`).
 */
const OSC7501: Grounded<SignalSupport> = {
  level: "native",
  channel: "osc7501",
  grounds: [{ code: "src/main/junto/term/program-status.ts#programStatusSignals" }],
};

/** The PTY child's exit code and signal (`AppTerminalBackend.attach`). */
const EXITED: Grounded<SignalSupport> = {
  level: "native",
  channel: "process",
  grounds: [{ code: "src/main/junto/app-process-plane.ts#pty.onExit" }],
};

/** Mail always asks to steer; `HARNESS_FOLLOW_UP` holds the Enter count. */
const STEER: Grounded<CommandSupport> = {
  level: "typed",
  channel: "pty",
  grounds: [{ template: "followUp.steering" }],
};

/** A queue submit distinct from steering. */
const QUEUE: Grounded<CommandSupport> = {
  level: "typed",
  channel: "pty",
  grounds: [{ template: "followUp.queue" }],
};

/** Respawn with the template's resume flag or subcommand. */
const RESUME: Grounded<CommandSupport> = {
  level: "native",
  channel: "process",
  grounds: [{ template: "argvSpec.resumeMode" }],
};

const typed = (...grounds: readonly CapabilityGround[]): Grounded<CommandSupport> => ({
  level: "typed",
  channel: "pty",
  grounds,
});

export const HARNESS_CAPABILITY_DECLARATIONS: Readonly<
  Record<HarnessId, HarnessCapabilityDeclaration>
> = {
  claude: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("osc_title_working", "live_status_line_working", "empty_prompt_idle", "osc_title_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("live_permission_form", "bash_permission_prompt", "generic_permission_prompt", "legacy_permission_blocker"),
      PermissionResolved: NONE,
      QuestionAsked: screen("dynamic_workflow_prompt"),
      DialogShown: screen("resume_summary_choice", "model_picker_menu"),
      UsageLimitHit: screen("usage_limit_choice", "usage_limit_continuing"),
      Retrying: screen("api_retry_working"),
      UsageLevel: NONE,
      CompactionStarted: screen("compacting_working"),
      CompactionEnded: NONE,
      ErrorRaised: screen("not_logged_in", "api_error", "prompt_too_long"),
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: typed({ rule: "queued_input_working" }),
      mailSteer: NONE,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: typed({ code: "src/main/junto/term/drive/claude-startup.ts#isClaudeCompactNoop" }),
      resume: RESUME,
    },
  },
  codex: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("osc_title_working", "screen_working_fallback", "empty_prompt_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("live_strong_attention", "weak_attention"),
      PermissionResolved: NONE,
      QuestionAsked: screen("live_strong_attention"),
      DialogShown: screen("live_strong_attention", "live_picker"),
      UsageLimitHit: screen("usage_limit_picker"),
      Retrying: screen("reconnecting_retry"),
      UsageLevel: NONE,
      CompactionStarted: screen("compacting_context"),
      CompactionEnded: screen("context_compacted"),
      ErrorRaised: screen("unauthorized_error", "high_demand_error", "context_length_exceeded"),
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  grok: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("osc_title_working", "grid_thinking_working", "prompt_hints_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("permission_hints_attention", "permission_scope_selector"),
      PermissionResolved: NONE,
      QuestionAsked: screen("question_dialog_hints_attention", "option_dialog_attention"),
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: typed({ rule: "waiting_tool_working" }),
      compact: NONE,
      resume: RESUME,
    },
  },
  hermes: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("osc_title_working", "grid_forging_working", "ready_footer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("dangerous_command_approval"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: screen("authentication_failed_attention"),
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  pi: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: OSC7501,
      TurnStarted: NONE,
      TurnEnded: OSC7501,
      ToolStarted: NONE,
      PermissionRequested: NONE,
      PermissionResolved: NONE,
      QuestionAsked: screen("resume_delete_confirm_attention"),
      DialogShown: screen("trust_selector_attention"),
      UsageLimitHit: NONE,
      Retrying: screen("retry_status"),
      UsageLevel: NONE,
      CompactionStarted: screen("compacting_status"),
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  "prime-agent": {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("working_literal", "osc_title_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: screen("tool_marker_working"),
      PermissionRequested: screen("permission_overlay_attention"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  kimi: {
    signals: {
      SessionIdentified: { level: "screen", channel: "screen", grounds: [{ code: "src/main/junto/term/templates/kimi-session.ts#extractKimiSessionIdFromText" }] },
      ActivityObserved: screen("braille_spinner_working", "prompt_footer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("current_approval_panel", "legacy_approval_panel"),
      PermissionResolved: NONE,
      QuestionAsked: screen("question_panel"),
      DialogShown: screen("model_not_configured_attention", "model_missing_error_attention"),
      UsageLimitHit: screen("usage_limit_retrying"),
      Retrying: screen("retrying_working"),
      UsageLevel: NONE,
      CompactionStarted: screen("compacting_context"),
      CompactionEnded: screen("compaction_complete", "compaction_cancelled"),
      ErrorRaised: screen("provider_auth_error", "context_overflow_error"),
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  muse: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("live_status_working", "bare_composer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: NONE,
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  devin: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: OSC7501,
      TurnStarted: NONE,
      TurnEnded: OSC7501,
      ToolStarted: screen("running_tools_footer", "tool_reading_timeout"),
      PermissionRequested: screen("permission_prompt"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: screen("workspace_trust_prompt"),
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: QUEUE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  cursor: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("spinner_working", "settled_composer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("write_file_approval", "approval_prompt"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: QUEUE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  agy: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: OSC7501,
      TurnStarted: NONE,
      TurnEnded: OSC7501,
      ToolStarted: NONE,
      PermissionRequested: OSC7501,
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: OSC7501,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: typed({ rule: "queued_input_working" }),
      mailSteer: NONE,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  amp: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("footer_status_working", "osc_title_idle", "untitled_empty_composer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("approval_wait_attention"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: screen("interrupt_menu_attention"),
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: screen("authentication_attention"),
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  fx: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("status_line_working", "empty_composer_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: screen("permission_dialog_attention"),
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  omp: {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: OSC7501,
      TurnStarted: NONE,
      TurnEnded: OSC7501,
      ToolStarted: NONE,
      PermissionRequested: OSC7501,
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: OSC7501,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: RESUME,
    },
  },
  // Junto's own controller: titles say working, idle or attention, never why.
  "junto-overseer": {
    signals: {
      SessionIdentified: NONE,
      ActivityObserved: screen("controller_working", "controller_idle"),
      TurnStarted: NONE,
      TurnEnded: NONE,
      ToolStarted: NONE,
      PermissionRequested: NONE,
      PermissionResolved: NONE,
      QuestionAsked: NONE,
      DialogShown: NONE,
      UsageLimitHit: NONE,
      Retrying: NONE,
      UsageLevel: NONE,
      CompactionStarted: NONE,
      CompactionEnded: NONE,
      ErrorRaised: NONE,
      ProcessExited: EXITED,
    },
    commands: {
      mailQueue: NONE,
      mailSteer: STEER,
      mailInterrupt: NONE,
      answerPermission: NONE,
      interrupt: NONE,
      compact: NONE,
      resume: NONE,
    },
  },
};

const withoutGrounds = <S extends { readonly level: string }>(support: S): S => {
  if (!("grounds" in support)) return support;
  const { grounds: _grounds, ...bare } = support;
  return bare as unknown as S;
};

const stripGrounds = <K extends string, S extends { readonly level: string }>(
  record: Readonly<Record<K, S>>,
): Readonly<Record<K, S>> =>
  Object.fromEntries(
    Object.entries<S>(record).map(([key, support]) => [key, withoutGrounds(support)]),
  ) as Record<K, S>;

/** The capability records `admitCommand` and features read. */
export const HARNESS_CAPABILITIES: Readonly<Record<HarnessId, HarnessCapabilities>> =
  Object.fromEntries(
    Object.entries<HarnessCapabilityDeclaration>(HARNESS_CAPABILITY_DECLARATIONS).map(
      ([harness, declaration]) => [
        harness,
        {
          signals: stripGrounds(declaration.signals),
          commands: stripGrounds(declaration.commands),
        },
      ],
    ),
  ) as Record<HarnessId, HarnessCapabilities>;

/** Capabilities for a harness id, or undefined when it names no template. */
export const harnessCapabilitiesFor = (harness: string): HarnessCapabilities | undefined =>
  isHarnessId(harness) ? HARNESS_CAPABILITIES[harness] : undefined;
