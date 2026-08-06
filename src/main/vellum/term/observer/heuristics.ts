/**
 * Vellum Command mention heuristics — scan agent/terminal output for signs that the
 * harness does not know Vellum Command, cannot find its CLI, or cannot reach
 * its runtime.
 *
 * This is a *low-precision hint layer* for awareness nudges, not state:
 * `scanHeuristics` returns every pattern hit (class + matched snippet). The
 * seed set below covers the canonical failure phrasings; normal usage
 * ("run vellum-command onboard", "vellum-command is the CLI") and our own
 * `[vc-…]` injection markers must never match.
 *
 * Rules of the seed set:
 *  - every bare `vellum` word-boundary is guarded with `(?!-)` so
 *    `vellum-command` (the legitimate binary name) is not an awareness hit;
 *  - env failures always require the `vellum-command` token itself, never a
 *    bare "command not found";
 *  - all patterns are case-insensitive; `[^\n]*` spans are capped to 80
 *    chars in the reported snippet.
 */

export type HeuristicClass = "awareness" | "env" | "protocol";

export type HeuristicHit = {
  readonly class: HeuristicClass;
  /** Human-readable identifier of the seed pattern that fired (its note). */
  readonly pattern: string;
  /** The matched text from the scan input, trimmed, ≤80 chars. */
  readonly matched: string;
};

export type VellumHeuristic = {
  readonly class: HeuristicClass;
  readonly pattern: RegExp;
  readonly note: string;
};

export const VELLUM_HEURISTICS: ReadonlyArray<VellumHeuristic> = [
  // ── awareness — agent does not know what Vellum Command is ──────────────
  {
    class: "awareness",
    pattern: /\bwhat (?:is|are|even is|the hell is) vellum(?!-)(?: command)?\b/gi,
    note: "what_is_vellum",
  },
  {
    class: "awareness",
    pattern: /\bwhat'?s vellum(?!-)(?: command)?\b/gi,
    note: "whats_vellum",
  },
  {
    class: "awareness",
    pattern: /\b(?:i |we )?don'?t (?:know|understand|recognize) (?:what )?vellum(?!-)/gi,
    note: "dont_know_vellum",
  },
  {
    class: "awareness",
    pattern: /\bnever heard of vellum(?!-)/gi,
    note: "never_heard_of_vellum",
  },
  {
    class: "awareness",
    pattern: /\b(?:unable|can'?t|cannot|couldn'?t) (?:to )?find (?:the |any )?vellum(?!-)(?: command)?\b/gi,
    note: "cannot_find_vellum",
  },
  {
    class: "awareness",
    pattern: /\bis vellum(?!-)(?: command)? (?:a |an )?(?:tool|thing|app|application|program|package|installed|real|available)\b/gi,
    note: "is_vellum_a_tool",
  },
  {
    class: "awareness",
    pattern: /\bdo you know (?:what )?vellum(?!-)/gi,
    note: "do_you_know_vellum",
  },
  {
    class: "awareness",
    pattern: /\bhow (?:do i|do you|can i|should i) use vellum(?!-)(?: command)?\b/gi,
    note: "how_to_use_vellum",
  },
  {
    class: "awareness",
    pattern: /\bvellum(?!-)(?: command)?\?(?:[^a-z0-9]|$)/gi,
    note: "vellum_question",
  },
  {
    class: "awareness",
    pattern: /\b(?:have you|did you) (?:ever )?(?:used|heard of|seen) vellum(?!-)/gi,
    note: "have_you_used_vellum",
  },

  // ── env — the vellum-command CLI/binary is missing or not runnable ────────
  {
    class: "env",
    pattern: /\bvellum-command\b[^\n]*command not found/gi,
    note: "vellum_command_not_found_after",
  },
  {
    class: "env",
    pattern: /\bcommand not found[^\n]*\bvellum-command\b/gi,
    note: "command_not_found_vellum",
  },
  {
    class: "env",
    pattern: /\b(?:zsh|bash|sh|fish|tcsh):[^\n]*\bvellum-command\b/gi,
    note: "shell_error_vellum",
  },
  {
    class: "env",
    pattern: /\bvellum-command\b[^\n]*(?:no such file or directory|not found|not installed|not recognized|unavailable|missing)/gi,
    note: "vellum_missing_after",
  },
  {
    class: "env",
    pattern: /(?:no such file or directory|not found|not installed|not recognized|unavailable|missing)[^\n]*\bvellum-command\b/gi,
    note: "vellum_missing_before",
  },
  {
    class: "env",
    pattern: /\b(?:executable|binary|program) (?:not found|missing|does not exist)[^\n]*\bvellum-command\b/gi,
    note: "executable_not_found",
  },
  {
    class: "env",
    pattern: /\b(?:cannot|can'?t|unable to) (?:find|locate|run|launch|execute|spawn|start)[^\n]*\bvellum-command\b/gi,
    note: "cannot_run_vellum",
  },
  {
    class: "env",
    pattern: /\bvellum-command\b[^\n]*is not (?:a (?:valid )?command|installed|available|recognized|found)/gi,
    note: "vellum_is_not_command",
  },
  {
    class: "env",
    pattern: /\b(?:unknown|invalid) command[^\n]*\bvellum-command\b/gi,
    note: "unknown_command_vellum",
  },
  {
    class: "env",
    pattern: /\bpermission denied\b[^\n]*\bvellum-command\b/gi,
    note: "vellum_permission_denied",
  },

  // ── protocol — the Vellum Command runtime / control channel is unreachable ─
  {
    class: "protocol",
    pattern: /\bcontrol\.sock\b/gi,
    note: "control_sock",
  },
  {
    class: "protocol",
    pattern: /\bruntime ?down\b/gi,
    note: "runtime_down",
  },
  {
    class: "protocol",
    pattern: /\bis vellum command running\b/gi,
    note: "is_vellum_running",
  },
  {
    class: "protocol",
    pattern: /\bpermission denied\b[^\n]*\bsock(?:et)?\b/gi,
    note: "socket_permission_denied",
  },
  {
    class: "protocol",
    pattern: /\bsock(?:et)?\b[^\n]*\bpermission denied\b/gi,
    note: "permission_denied_socket",
  },
  {
    class: "protocol",
    pattern: /\bwork socket\b/gi,
    note: "work_socket",
  },
  {
    class: "protocol",
    pattern: /\btoken (?:unavailable|missing|expired|invalid|not found)\b/gi,
    note: "token_unavailable",
  },
  {
    class: "protocol",
    pattern: /\b(?:unable|cannot|can'?t|failed) to (?:connect|reach|open|bind)[^\n]*\b(?:sock(?:et)?|control|daemon|runtime)\b/gi,
    note: "cannot_connect_runtime",
  },
  {
    class: "protocol",
    pattern: /\bconnection refused\b[^\n]*\b(?:sock(?:et)?|control|daemon|runtime)\b/gi,
    note: "connection_refused",
  },
  {
    class: "protocol",
    pattern: /\b(?:control|work|command) (?:socket|channel|pipe)\b[^\n]*\b(?:down|closed|unavailable|missing|gone|failed|refused)\b/gi,
    note: "control_channel_down",
  },
];

/**
 * Scan text for all heuristic hits. One hit per pattern per match; the
 * matched snippet is trimmed and capped at 80 chars.
 */
export const scanHeuristics = (text: string): ReadonlyArray<HeuristicHit> => {
  const hits: HeuristicHit[] = [];
  for (const h of VELLUM_HEURISTICS) {
    for (const m of text.matchAll(h.pattern)) {
      if (m.index === undefined) continue;
      hits.push({
        class: h.class,
        pattern: h.note,
        matched: m[0].trim().slice(0, 80),
      });
    }
  }
  return hits;
};
