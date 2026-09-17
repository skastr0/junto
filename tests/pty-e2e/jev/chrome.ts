/**
 * Grounded chrome literals, per harness.
 *
 * Every entry was READ OFF a committed capture (`tests/pty-e2e/corpus`) through
 * the real `SessionObserver`, or — where the corpus never painted it — carried
 * over from the harness's own rule pack and marked as such in `provenance`.
 * The generator records which probes actually matched a cut, so a declaration
 * the corpus cannot support shows up as `unobservedProbes` instead of quietly
 * grounding nothing.
 *
 * The five `live_turn` literals that `scenarios/harness-classification.test.ts`
 * already read off the captures (claude, codex, grok, pi, devin) are reused
 * verbatim so the two suites cannot drift apart.
 *
 * Deliberately NOT chrome:
 *  - `⏸ manual mode on · esc to interrupt` (claude) — a permanent footer hint
 *    that is also present mid-turn, so it separates nothing.
 *  - muse's `warning: local session messaging unavailable` — a product warning
 *    about local session messaging, not a failed execution attempt, so it
 *    grounds no concern and the label abstains instead.
 */

import type { ChromeProbe, ConcernId } from "./types";

type ProbeInput = Omit<ChromeProbe, "flags"> & { readonly flags?: string };

const probe = (input: ProbeInput): ChromeProbe => ({
  flags: input.flags ?? "u",
  ...input,
});

const live = (
  id: string,
  where: ChromeProbe["where"],
  source: string,
  literal: string,
  provenance: string,
  flags?: string,
): ChromeProbe =>
  probe({ id, kind: "live_turn", role: "live_turn", where, source, literal, provenance, ...(flags ? { flags } : {}) });

const dialog = (
  id: string,
  concern: ConcernId,
  where: ChromeProbe["where"],
  source: string,
  literal: string,
  provenance: string,
  flags?: string,
): ChromeProbe =>
  probe({ id, kind: "dialog", role: "dialog", concern, where, source, literal, provenance, ...(flags ? { flags } : {}) });

/** Harness's own settled-ready chrome — the negative-control selector. */
export const IDLE_PROBES: Readonly<Record<string, readonly ChromeProbe[]>> = {
  amp: [
    probe({
      id: "amp.settled_empty_composer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "^\\s*╰─+ ◷ ─",
      literal: "╰──────── ◷ ─       ─ <CWD>                     ◷",
      provenance: "P1 amp/startup-idle settled box (Loading Thread text gone)",
    }),
  ],
  claude: [
    probe({
      id: "claude.idle_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "\\? for shortcuts",
      literal: "⏸ manual mode on · ? for shortcuts · ← for agents",
      provenance: "P1 claude/startup-idle + claude/type-echo footer (working footer reads `esc to interrupt`)",
    }),
  ],
  codex: [
    probe({
      id: "codex.composer_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "gpt-5\\.4-mini low ·",
      literal: "gpt-5.4-mini low · <CWD>",
      provenance: "P1 codex/startup-idle + codex/type-echo idle composer footer",
    }),
  ],
  grok: [
    probe({
      id: "grok.idle_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "Grok 4\\.5 \\(low\\) · \\d+K / 500K",
      literal: "Grok 4.5 (low) · 22K / 500K (4%) · ctrl+o transcript",
      provenance: "P1 grok/startup-idle idle footer",
    }),
  ],
  devin: [
    probe({
      id: "devin.context_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "Context: \\d+k / \\d+k tokens",
      literal: "SWE-1.6 Slow                    Context: 43k / 200k tokens (21%)",
      provenance: "P1 devin/type-echo settled context footer",
    }),
  ],
  hermes: [
    probe({
      id: "hermes.ready_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "─ ready │",
      literal: "─ ready │ gpt 5.4 mini │ 1s │ voice off │ 1 session",
      provenance: "P1 hermes/* footer `ready` state",
    }),
  ],
  kimi: [
    probe({
      id: "kimi.prompt_footer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "No session yet — one will be created on your first message\\.",
      literal: "No session yet — one will be created on your first message.",
      provenance: "P1 kimi/startup-idle + kimi/type-echo (auth-blocked: a settled ready composer was never painted)",
    }),
  ],
  muse: [
    probe({
      id: "muse.bare_composer",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "Voice input \\(⌥ \\+ v to start\\)",
      literal: "── Voice input (⌥ + v to start) ──",
      provenance: "P1 muse/startup-idle + muse/type-echo + muse/working-turn composer frame",
    }),
  ],
  omp: [
    probe({
      id: "omp.idle_title",
      kind: "dialog",
      role: "settled_idle",
      where: "title",
      source: "^π > omp$",
      literal: "π > omp",
      provenance: "P1 omp/startup-idle OSC title (working title is `π ⠋ omp`)",
    }),
  ],
  pi: [
    probe({
      id: "pi.editor_idle",
      kind: "dialog",
      role: "settled_idle",
      where: "screen",
      source: "%/400k \\(auto\\)",
      literal: "%/400k (auto)",
      provenance: "harness-classification.test.ts CHROME.pi.idle",
    }),
  ],
};

/** `live_turn` chrome — the harness's own mid-turn paint. */
export const LIVE_TURN_PROBES: Readonly<Record<string, readonly ChromeProbe[]>> = {
  amp: [
    live(
      "amp.osc_title_braille",
      "title",
      "[\\u2800-\\u28FF]",
      "⢺ Coding workspace - amp - <CWD>",
      "P1 amp/working-turn OSC titles ⢺/⢑/⣿; amp rule osc_title_working",
    ),
    live(
      "amp.footer_streaming",
      "screen",
      "╰\\s*[∼≈≋]\\s*(?:Streaming|Sending)\\b",
      "╰ ∼ Streaming ────────────────── ◷ ─       ─ <CWD>                     ◷",
      "P1 amp/working-turn + amp/paste-chip footer; amp rule footer_status_working",
      "mu",
    ),
  ],
  claude: [
    live(
      "claude.live_status_line",
      "screen",
      "…\\s*\\(\\d+s\\b",
      "✢ Imagining… (2s · ↓ 102 tokens · thinking)",
      "harness-classification.test.ts CHROME.claude.working `\\(\\d+s[^)]*thinking\\)` + P1 claude/paste-chip, claude/working-turn",
    ),
    live(
      "claude.osc_title_braille",
      "title",
      "^[\\u2800-\\u28FF] ",
      "⠐ Untitled session",
      "claude rule osc_title_working; P1 claude/paste-chip title",
    ),
  ],
  codex: [
    live(
      "codex.working_footer",
      "screen",
      "Working \\(\\d+s\\s*•\\s*esc to interrupt\\)",
      "• Working (1s • esc to interrupt)",
      "harness-classification.test.ts CHROME.codex.working; P1 codex/working-turn + codex/paste-chip",
    ),
    live(
      "codex.osc_title_spinner",
      "title",
      "[\\u2800-\\u28FF]",
      "⠼ codex",
      "codex rule osc_title_working; P1 codex/type-echo + codex/working-turn titles",
    ),
  ],
  grok: [
    live(
      "grok.status_line",
      "screen",
      "(?:Responding…|◆ Thinking…|⠙ Waiting for response…)",
      "⠙ Waiting for response… 1.6s",
      "harness-classification.test.ts CHROME.grok.working; P1 grok/paste-chip + grok/working-turn",
    ),
  ],
  devin: [
    live(
      "devin.turn_footer",
      "screen",
      "· \\d+s \\(esc twice to interrupt\\)",
      "⡆⠀ Thinking · 3s (esc twice to interrupt)",
      "harness-classification.test.ts CHROME.devin.working; P1 devin/type-echo + devin/working-turn",
    ),
  ],
  hermes: [
    live(
      "hermes.osc_title_hourglass",
      "title",
      "^⏳",
      "⏳ gpt-5.4-mini · …llum-capture-cwd/hermes",
      "hermes rule osc_title_working; P1 hermes/paste-chip title",
    ),
    live(
      "hermes.mulling",
      "screen",
      "mulling…|Ctrl\\+C to interrupt",
      "⠴ (◔_◔) mulling…       │ gpt 5.4 mini │ 1m 1s │ voice off │ 1 session",
      "P1 hermes/paste-chip rendered `mulling…` and `❯ Ctrl+C to interrupt…`",
    ),
  ],
  kimi: [],
  muse: [
    live(
      "muse.turn_footer",
      "screen",
      "[◇◆◈] (?:Thinking|Working) \\(\\d+s · esc to interrupt\\)",
      "◆ Thinking (1s · esc to interrupt)",
      "muse rule live_status_working; P1 muse/type-echo + muse/working-turn",
    ),
    live(
      "muse.osc_title_braille",
      "title",
      "^[\\u2800-\\u28FF] muse$",
      "⠹ muse",
      "P1 muse/type-echo + muse/working-turn titles",
    ),
  ],
  omp: [
    live(
      "omp.working_line",
      "screen",
      "Working…",
      " 󱊷 Working…",
      "omp rule working_line_working; P1 omp/type-echo + omp/working-turn",
    ),
    live(
      "omp.osc_title_spinner",
      "title",
      "^π [\\u2800-\\u28FF]",
      "π ⠋ omp",
      "P1 omp/working-turn titles (idle title is `π > omp`)",
    ),
  ],
  pi: [
    live(
      "pi.turn_footer",
      "screen",
      "· \\d+s \\(esc (?:twice )?to interrupt\\)",
      "· 12s (esc to interrupt)",
      "harness-classification.test.ts CHROME.pi.working",
    ),
    live(
      "pi.working_literal",
      "screen",
      "Working\\.\\.\\.|Compacting context\\.\\.\\.",
      "Working...",
      "pi rule working_literal / compacting_status (never painted in the P1 pi captures)",
    ),
  ],
};

/** Dialog chrome — the harness's own pending-human paint. */
export const DIALOG_PROBES: Readonly<Record<string, readonly ChromeProbe[]>> = {
  amp: [
    dialog(
      "amp.access_failure",
      "access_problem",
      "screen",
      "(?:not logged in|login required|authentication required|sign in to continue)\\b",
      "login required",
      "amp rule authentication_attention (never painted in the P1 amp captures)",
      "iu",
    ),
    dialog(
      "amp.approval_wait",
      "approval_requested",
      "screen",
      "waiting for approval",
      "waiting for approval",
      "amp rule approval_wait_attention (never painted in the P1 amp captures)",
      "iu",
    ),
  ],
  claude: [
    dialog(
      "claude.select_login_method",
      "access_problem",
      "screen",
      "Select login method:|Run /login",
      "Select login method:",
      "P1 claude/mail-notice rendered dialog",
      "iu",
    ),
    dialog(
      "claude.select_login_method_choice",
      "answer_requested",
      "screen",
      "Select login method:",
      "Select login method:",
      "P1 claude/mail-notice rendered dialog (three numbered options posed to the human)",
    ),
    dialog(
      "claude.permission_prompt",
      "approval_requested",
      "screen",
      "do you want to proceed\\?|esc to cancel",
      "Do you want to proceed?",
      "claude rule permission gate — corpus has NO capture (manifest skips permission-returns-idle)",
      "iu",
    ),
  ],
  codex: [
    dialog(
      "codex.trust_or_approval",
      "approval_requested",
      "screen",
      "do you trust the contents of this directory|working with untrusted contents|review the hooks that will run|allow command\\?",
      "Do you trust the contents of this directory?",
      "codex rule live_strong_attention — P1 codex/startup-idle shows the settled composer, not the modal",
      "iu",
    ),
  ],
  grok: [
    dialog(
      "grok.permission_options",
      "approval_requested",
      "screen",
      "Yes, and don't ask again|Yes, proceed|No, reject|ctrl\\+o:yolo",
      "(●) Yes, and don't ask again for anything (always-approve mode)",
      "P1 grok/permission-returns-idle rendered rows 29-31",
      "iu",
    ),
    dialog(
      "grok.permission_options_choice",
      "answer_requested",
      "screen",
      "\\(●\\)|\\(○\\)",
      "(○) Yes, proceed",
      "P1 grok/permission-returns-idle rendered radio options",
    ),
  ],
  devin: [
    dialog(
      "devin.workspace_trust",
      "approval_requested",
      "screen",
      "Do you trust the authors of this directory",
      "✱ Do you trust the authors of this directory?",
      "P1 devin/startup-trust rendered dialog (the literal stops short of the trailing `?` so a mid-paint frame still matches)",
      "iu",
    ),
    dialog(
      "devin.trust_folder",
      "approval_requested",
      "screen",
      "✓ Trust ",
      "✓ Trust <CWD>?",
      "P1 devin/mail-notice rendered dialog (the literal stops short of the trailing `?` so a mid-paint frame still matches)",
    ),
    dialog(
      "devin.permission_prompt",
      "approval_requested",
      "screen",
      "approve once",
      "approve once",
      "devin rule permission_prompt (never painted in the P1 devin captures)",
      "iu",
    ),
  ],
  hermes: [
    dialog(
      "hermes.credentials_missing",
      "access_problem",
      "screen",
      "No Codex credentials stored|hermes auth",
      "error: agent init failed: No Codex credentials stored. Run `hermes auth` to authenticate.",
      "P1 hermes/startup-idle + type-echo + paste-chip rendered error line",
      "iu",
    ),
    dialog(
      "hermes.agent_init_failed",
      "execution_error",
      "screen",
      "error: agent init failed",
      "error: agent init failed: No Codex credentials stored.",
      "P1 hermes/startup-idle + type-echo + paste-chip rendered error line",
      "iu",
    ),
  ],
  kimi: [
    dialog(
      "kimi.model_not_set",
      "access_problem",
      "screen",
      "Model:\\s+not set, run /login or /provider",
      "│  Model:     not set, run /login or /provider",
      "P1 kimi/startup-idle + kimi/type-echo rendered dialog",
    ),
    dialog(
      "kimi.llm_not_set",
      "execution_error",
      "screen",
      "Error: LLM not set",
      "Error: LLM not set, send \"/login\" to login",
      "P1 kimi/type-echo rendered error line (the literal stops at the part that is on screen even mid-paint)",
    ),
  ],
  muse: [],
  omp: [
    dialog(
      "omp.approval_dialog",
      "approval_requested",
      "screen",
      "allow once|requires approval|allow all",
      "allow once",
      "omp rule approval_dialog_attention (never painted in the P1 omp captures)",
      "iu",
    ),
  ],
  pi: [
    dialog(
      "pi.no_api_key",
      "access_problem",
      "screen",
      "No API key found|Use /login to log into a provider",
      "Error: No API key found for builtin-mock-responses.",
      "P1 pi/type-echo rendered error lines",
      "iu",
    ),
    dialog(
      "pi.no_api_key_error",
      "execution_error",
      "screen",
      "Error: No API key found",
      "Error: No API key found for builtin-mock-responses.",
      "P1 pi/type-echo rendered error line",
    ),
    dialog(
      "pi.trust_selector",
      "approval_requested",
      "screen",
      "Trust project folder\\?",
      "Trust project folder?",
      "pi rule trust_selector_attention (never painted in the P1 pi captures)",
      "iu",
    ),
  ],
};

/** Every probe declared for a harness, in selection-priority order. */
export const probesFor = (harness: string): readonly ChromeProbe[] => [
  ...(DIALOG_PROBES[harness] ?? []),
  ...(LIVE_TURN_PROBES[harness] ?? []),
  ...(IDLE_PROBES[harness] ?? []),
];

export const compileProbe = (probe: ChromeProbe): RegExp =>
  new RegExp(probe.source, probe.flags);

/** Harnesses with at least one committed capture. */
export const HARNESSES = [
  "amp",
  "claude",
  "codex",
  "devin",
  "grok",
  "hermes",
  "kimi",
  "muse",
  "omp",
  "pi",
] as const;
export type HarnessName = (typeof HARNESSES)[number];
