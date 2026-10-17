/**
 * Kimi Code seat rules — grid-primary. The OSC title is static "Kimi Code"
 * (dead — never key on it) and there is no OSC 9 progress, so the grid
 * carries the pack: approval + question panels →
 * attention; moon/braille spinners + background-agent line → working) plus
 * the TUI prompt box "> " and status footer "context: 0% (0/1M)" (idle).
 * No alt screen — the grid includes the whole session like codex.
 * Patterns from the 2026-08 agent-CLI sweep of kimi
 *
 * Composer grounded in P1 corpus kimi/* captured 2026-09-14 from Kimi Code
 * 0.43.0: boxed `│ > … │` above `context:`. Folder-trust pickers use `❯`
 * and do not match. (rewritten; not vendored; (?i) inline flags are not
 * valid in this runtime, so case-insensitivity is spelled out with
 * character classes).
 */

import type { SeatRulePack } from "../types";

export const kimiRules: SeatRulePack = {
  harness: "kimi",
  version: "2026.10.17.1",
  rules: [
    {
      id: "model_not_configured_attention",
      state: "attention",
      signal: { _tag: "DialogShown", kind: "login" },
      priority: 1300,
      region: "whole_recent",
      visibleAttention: true,
      // P1 startup has a writable box but explicitly reports no model in
      // the welcome panel. Empty composer chrome cannot make it runnable.
      matchers: {
        contains: ["welcome to kimi code!"],
        lineRegex: ["^\\s*│\\s+Model:\\s+not set, run /login or /provider\\s*│\\s*$"],
      },
    },
    {
      id: "model_missing_error_attention",
      state: "attention",
      signal: { _tag: "DialogShown", kind: "login" },
      priority: 1300,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      // P1 type-echo returns to the box after rejecting the turn. Match
      // the current error directly above that box, not old transcript text.
      matchers: {
        regex: ["(?:^|\\n)\\s*Error: LLM not set, send \"/login\" to login[^\\n]*\\n\\s*╭─"],
      },
    },
    // "↵ confirm" + a question + " choose" + approve/reject/revise.
    // Bottom-scoped: transcript replay of an old approval must not pin NEEDS INPUT.
    {
      id: "current_approval_panel",
      state: "attention",
      signal: { _tag: "PermissionRequested" },
      priority: 1200,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["↵ confirm"],
        any: [
          { contains: ["run this command?"] },
          { contains: ["write this file?"] },
          { contains: ["apply these edits?"] },
          { contains: ["stop this task?"] },
          { contains: ["ready to build with this plan?"] },
          { lineRegex: ["^\\s*▶?\\s*[Aa]pprove .*\\?$"] },
        ],
        all: [
          { contains: [" choose"] },
          {
            any: [
              { contains: ["approve"] },
              { contains: ["reject"] },
              { contains: ["revise"] },
            ],
          },
        ],
      },
    },
    // Question panel: "↑↓ select" + "esc cancel" + "↵ choose/toggle/save".
    {
      id: "question_panel",
      state: "attention",
      signal: { _tag: "QuestionAsked" },
      priority: 1190,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["↑↓ select", "esc cancel"],
        lineRegex: ["^\\s*question\\s*$", "^\\s*\\? "],
        any: [
          { contains: ["↵ choose"] },
          { contains: ["↵ toggle"] },
          { contains: ["↵ save"] },
        ],
      },
    },
    // Legacy approval panel: "requesting approval" + "reject" + approve-once
    // chrome + "1/2/3/4 choose" or "↵ confirm".
    {
      id: "legacy_approval_panel",
      state: "attention",
      signal: { _tag: "PermissionRequested" },
      priority: 1150,
      region: "bottom_non_empty_lines",
      regionN: 16,
      visibleAttention: true,
      matchers: {
        contains: ["requesting approval", "reject"],
        any: [
          { contains: ["approve once"] },
          { contains: ["approve for this session"] },
        ],
        all: [
          {
            any: [
              { contains: ["1/2/3/4 choose"] },
              { contains: ["↵ confirm"] },
            ],
          },
        ],
      },
    },
    // A turn that ended on a rejected API key: the seat cannot take mail until
    // its credentials are fixed. Only while the error is the last thing above
    // the box, so the next turn pushes it out. Capture: corpus/kimi/error-auth
    // ("Error: [provider.auth_error] 401 Incorrect API key provided.").
    {
      id: "provider_auth_error",
      state: "attention",
      signal: { _tag: "ErrorRaised", kind: "auth" },
      priority: 1080,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        regex: [
          "(?:^|\\n)\\s*Error:\\s+(?<message>\\[provider\\.auth_error\\][^\\n]*?)[ \\t]*(?:\\n(?!\\s*╭)[^\\n]*){0,3}\\n\\s*╭─",
        ],
      },
    },
    // A usage limit is retried like a rate limit: the moon line says
    // "Retrying (2/10) \u00B7 APIProviderRateLimitError \u00B7 in 1s" and the
    // line under it "429 \u00B7 429 The usage limit has been reached". The
    // screen names no window and no reset, so the scope is unknown, and it
    // does not say the turn resumes at a reset. Mail holds while it stands.
    // Capture: corpus/kimi/usage-limit, usage-limit-weekly.
    {
      id: "usage_limit_retrying",
      state: "attention",
      signal: { _tag: "UsageLimitHit", scope: "unknown" },
      priority: 1070,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        regex: [
          "(?:^|\\n)\\s*(?:🌕|🌖|🌗|🌘|🌑|🌒|🌓|🌔)\\s+Retrying\\b[^\\n]*\\n[ \\t]{4,}(?<message>[^\\n]*\\busage limit has been reached\\b[^\\n]*?)[ \\t]*(?:\\n|$)",
        ],
      },
    },
    // The moon line during a retry: attempt, the error class, the wait, and
    // under it the provider's status line, which names the cause ("503 The
    // server is overloaded", "Connection error.", "500 Internal server
    // error"). Above the plain moon spinner so the retry is not lost to it.
    // Eight lines: the moon line, the status line, the box and its footer.
    // Captures: corpus/kimi/retry-*, error-server.
    {
      id: "retrying_working",
      state: "working",
      signal: { _tag: "Retrying", cause: "unknown" },
      priority: 1062,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        regex: [
          "(?:^|\\n)\\s*(?:🌕|🌖|🌗|🌘|🌑|🌒|🌓|🌔)\\s+Retrying\\b(?:\\s+\\((?<attempt>\\d+)/(?<max>\\d+)\\))?(?<cause>[^\\n]*(?:\\n[ \\t]{4,}\\S[^\\n]*)?)",
          "^(?:[\\s\\S]*?Retrying\\b[^\\n]*\\u00B7\\s+in\\s+(?<retryInMs>\\d+(?:\\.\\d+)?\\s*(?:ms|s|m))\\b)?",
        ],
      },
    },
    // "\u25CF Compacting context\u2026 \u00B7 Tip: \u2026", its bullet blinking. The same
    // line for /compact and for the compaction a context overflow starts, so
    // the trigger is unknown. Captures: corpus/kimi/compaction-manual,
    // error-context.
    {
      id: "compacting_context",
      state: "working",
      signal: { _tag: "CompactionStarted", trigger: "unknown" },
      priority: 1061,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        lineRegex: ["^\\s*(?:\\u25CF\\s+)?Compacting context\\u2026"],
      },
    },
    // Background subagent status: "kimi… thinking … [N agents running]".
    {
      id: "background_agent_status_working",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 3,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "\\bkimi[-\\w.]*\\s+[Tt]hinking\\b.*\\[[1-9][0-9]*\\s+agents?\\s+running\\]",
        ],
      },
    },
    // Moon-phase spinner: a lone 🌕…🌔 line in the live status strip only.
    // Never whole_recent — a prior turn's moon glyph in scrollback would pin
    // working forever after the agent returned to the prompt.
    {
      id: "moon_spinner_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        // 2.1.1 writes a tip after the glyph: "\u{1F311} \u00B7 Tip: \u2026"
        // (corpus/kimi/retry-*, the turn before its first retry).
        lineRegex: ["^\\s*(🌕|🌖|🌗|🌘|🌑|🌒|🌓|🌔)(?:\\s*$|\\s+\\u00B7\\s)"],
      },
    },
    // Braille spinner + thinking.../working.../using (tool status lines).
    // Bottom-scoped for the same scrollback-pin reason as moon_spinner.
    {
      id: "braille_spinner_working",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        lineRegex: [
          "^\\s*[\\u2800-\\u28FF]+\\s*([Tt]hinking\\.\\.\\.|[Ww]orking\\.\\.\\.|[Uu]sing )",
        ],
      },
    },
    // Prompt box "> " + status footer "context: 0% (0/1M)" — always-on idle
    // chrome. Below live working rules (bottom-scoped): when the agent is
    // truly idle the status strip has no moon/braille, so this fires cleanly.
    // Keep priority under working so a live spinner in the same strip still wins.
    {
      id: "osc9_working",
      state: "working",
      priority: 300,
      region: "osc9",
      visibleWorking: true,
      // Real kimi emits OSC 9;4;3 progress windows during turns
      // (working-turn.jsonl: 4;3 across the 3–16KB buckets) and 4;0; at
      // idle. 4;3 is the harness's deterministic mid-turn flag — above all
      // idle chrome (welcome box / prompt footer).
      matchers: { regex: ["^4;3;?$"] },
    },
    {
      id: "welcome_idle",
      state: "idle",
      priority: 160,
      region: "whole_recent",
      visibleIdle: true,
      // Real kimi 0.34.0 startup (startup-idle.jsonl): welcome box
      // "Welcome to Kimi Code!" + "context: 0% (0/1M)" footer, composer
      // glyph hidden inside a frame (prompt_footer_idle's `^\s*>` line
      // gate cannot fire). The welcome box is always-on kimi chrome; a live
      // working strip outranks it via osc9_working / moon / braille rules.
      matchers: {
        contains: ["welcome to kimi code!", "context:"],
      },
    },
    {
      id: "prompt_footer_idle",
      state: "idle",
      priority: 150,
      region: "bottom_non_empty_lines",
      regionN: 4,
      visibleIdle: true,
      matchers: {
        contains: ["context:"],
        lineRegex: ["^\\s*>"],
      },
    },
  ],
  // Errors and compaction ends a turn shows, beside whatever state the
  // screen reads. Captures: corpus/kimi/compaction-manual, error-context.
  facts: [
    {
      id: "compaction_complete",
      region: "bottom_non_empty_lines",
      regionN: 10,
      signal: { _tag: "CompactionEnded", ok: true },
      // "\u25CF Compaction complete (21169 \u2192 21735 tokens) (Ctrl-O to show compaction summary)"
      matchers: {
        lineRegex: ["^\\s*\\u25CF\\s+Compaction complete \\((?<tokensBefore>[\\d,]+)\\s*\\u2192\\s*(?<tokensAfter>[\\d,]+) tokens\\)"],
      },
    },
    {
      id: "compaction_cancelled",
      region: "bottom_non_empty_lines",
      regionN: 10,
      signal: { _tag: "CompactionEnded", ok: false },
      matchers: { lineRegex: ["^\\s*\\u25CF\\s+Compaction cancelled\\b"] },
    },
    {
      id: "context_overflow_error",
      region: "bottom_non_empty_lines",
      regionN: 10,
      signal: { _tag: "ErrorRaised", kind: "contextOverflow" },
      // "Error: [compaction.failed] APIContextOverflowError: 400 Your input exceeds the context window\u2026"
      matchers: {
        lineRegex: ["^\\s*Error:\\s+(?<message>(?:\\[[\\w.]+\\]\\s+)?APIContextOverflowError\\b.*?)\\s*$"],
      },
    },
  ],
  composer: [
    {
      id: "composer_content_draft",
      verdict: "draft",
      region: "bottom_non_empty_lines",
      regionN: 6,
      matchers: {
        // Closing `│` is box chrome, never draft content.
        lineRegex: ["^\\s*\\u2502\\s*>\\s+[^\\u2502\\s]"],
        not: [{ contains: ["trust this folder"] }],
      },
    },
    {
      id: "bare_prompt_empty",
      verdict: "empty",
      region: "bottom_non_empty_lines",
      regionN: 6,
      matchers: {
        lineRegex: ["^\\s*\\u2502\\s*>\\s*\\u2502\\s*$"],
        contains: ["context:"],
        not: [
          { lineRegex: ["^\\s*\\u2502\\s*>\\s+[^\\u2502\\s]"] },
          { contains: ["trust this folder"] },
        ],
      },
    },
  ],
};
