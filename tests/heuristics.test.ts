import { describe, expect, it } from "vitest";
import {
  scanHeuristics,
  VELLUM_HEURISTICS,
  type HeuristicClass,
} from "../src/main/vellum/term/observer/heuristics";

/**
 * One canonical phrase per seed pattern, keyed by the pattern's note.
 * Every entry must produce at least one hit carrying that note.
 */
const CANONICAL: ReadonlyArray<{ note: string; class: HeuristicClass; phrase: string }> = [
  // awareness
  { note: "what_is_vellum", class: "awareness", phrase: "what is vellum?" },
  { note: "whats_vellum", class: "awareness", phrase: "what's vellum command" },
  { note: "dont_know_vellum", class: "awareness", phrase: "I don't know what vellum is" },
  { note: "never_heard_of_vellum", class: "awareness", phrase: "I have never heard of vellum" },
  { note: "cannot_find_vellum", class: "awareness", phrase: "unable to find vellum" },
  { note: "is_vellum_a_tool", class: "awareness", phrase: "is vellum a tool?" },
  { note: "do_you_know_vellum", class: "awareness", phrase: "do you know vellum" },
  { note: "how_to_use_vellum", class: "awareness", phrase: "how do I use vellum" },
  { note: "vellum_question", class: "awareness", phrase: "vellum command?" },
  { note: "have_you_used_vellum", class: "awareness", phrase: "have you ever used vellum" },
  // env
  { note: "vellum_command_not_found_after", class: "env", phrase: "vellum-command: command not found" },
  { note: "command_not_found_vellum", class: "env", phrase: "command not found: vellum-command" },
  { note: "shell_error_vellum", class: "env", phrase: "zsh: command not found: vellum-command" },
  { note: "vellum_missing_after", class: "env", phrase: "vellum-command: No such file or directory" },
  { note: "vellum_missing_before", class: "env", phrase: "no such file or directory: vellum-command" },
  { note: "executable_not_found", class: "env", phrase: "executable not found: vellum-command" },
  { note: "cannot_run_vellum", class: "env", phrase: "cannot find vellum-command" },
  { note: "vellum_is_not_command", class: "env", phrase: "vellum-command is not a command" },
  { note: "unknown_command_vellum", class: "env", phrase: "unknown command: vellum-command" },
  { note: "vellum_permission_denied", class: "env", phrase: "permission denied: ./vellum-command" },
  // protocol
  { note: "control_sock", class: "protocol", phrase: "control.sock" },
  { note: "runtime_down", class: "protocol", phrase: "RuntimeDown" },
  { note: "is_vellum_running", class: "protocol", phrase: "Is Vellum Command running?" },
  { note: "socket_permission_denied", class: "protocol", phrase: "permission denied: control.sock" },
  { note: "permission_denied_socket", class: "protocol", phrase: "control.sock: permission denied" },
  { note: "work_socket", class: "protocol", phrase: "work socket" },
  { note: "token_unavailable", class: "protocol", phrase: "token unavailable" },
  { note: "cannot_connect_runtime", class: "protocol", phrase: "unable to connect to control.sock" },
  { note: "connection_refused", class: "protocol", phrase: "connection refused: control.sock" },
  { note: "control_channel_down", class: "protocol", phrase: "control socket down" },
];

const notes = new Set(CANONICAL.map((c) => c.note));

describe("VELLUM_HEURISTICS seed set", () => {
  it("ships 20–30 patterns across all three classes", () => {
    expect(VELLUM_HEURISTICS.length).toBeGreaterThanOrEqual(20);
    expect(VELLUM_HEURISTICS.length).toBeLessThanOrEqual(30);
    for (const cls of ["awareness", "env", "protocol"] as const) {
      expect(
        VELLUM_HEURISTICS.filter((h) => h.class === cls).length,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("every pattern has a unique note covered by the canonical table", () => {
    expect(notes.size).toBe(CANONICAL.length);
    for (const h of VELLUM_HEURISTICS) {
      expect(notes.has(h.note)).toBe(true);
    }
  });

  it("every pattern is case-insensitive and global (matchAll-safe)", () => {
    for (const h of VELLUM_HEURISTICS) {
      expect(h.pattern.flags).toContain("i");
      expect(h.pattern.flags).toContain("g");
    }
  });
});

describe("scanHeuristics — canonical phrases", () => {
  for (const h of VELLUM_HEURISTICS) {
    it(`${h.class}:${h.note} fires on its canonical phrase`, () => {
      const phrase = CANONICAL.find((c) => c.note === h.note)!.phrase;
      const hits = scanHeuristics(phrase);
      expect(hits.some((hit) => hit.pattern === h.note)).toBe(true);
      expect(hits.every((hit) => hit.class === h.class)).toBe(true);
    });
  }

  it("≥3 patterns per class match canonical phrases", () => {
    for (const cls of ["awareness", "env", "protocol"] as const) {
      const matched = VELLUM_HEURISTICS.filter((h) =>
        scanHeuristics(
          CANONICAL.find((c) => c.note === h.note)!.phrase,
        ).some((hit) => hit.pattern === h.note),
      );
      expect(matched.filter((h) => h.class === cls).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("reports matched snippets capped at 80 chars", () => {
    const long = "zsh: " + "x".repeat(200) + " vellum-command: command not found";
    const hits = scanHeuristics(long);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.matched.length).toBeLessThanOrEqual(80);
      expect(hit.matched.length).toBeGreaterThan(0);
    }
  });

  it("returns one hit per pattern per occurrence", () => {
    const hits = scanHeuristics(
      "control.sock and again control.sock",
    );
    expect(hits.filter((h) => h.pattern === "control_sock").length).toBe(2);
  });

  it("matches shell-prefixed failures case-insensitively", () => {
    const hits = scanHeuristics("ZSH: COMMAND NOT FOUND: VELLUM-COMMAND");
    expect(hits.some((h) => h.class === "env")).toBe(true);
    expect(hits.some((h) => h.pattern === "shell_error_vellum")).toBe(true);
    expect(hits.some((h) => h.pattern === "command_not_found_vellum")).toBe(true);
  });
});

describe("scanHeuristics — must NOT match", () => {
  const NEGATIVE: ReadonlyArray<string> = [
    // Normal usage of the binary name — not a failure.
    "vellum-command onboard",
    "I'll run vellum-command onboard the station",
    "you can invoke vellum-command anytime",
    "please install vellum-command",
    "vellum-command is the CLI we use",
    // Bare failure words without the vellum-command token.
    "command not found",
    "no such file or directory",
    "permission denied",
    "runtime is fast",
    // Our own injection markers must never be flagged.
    "[vc-9f3a2b]",
    "[vc-command-9f3a2b] run the deploy",
    "❯ [vc-abc123] please check the fleet",
    "[vc-abc123] zsh: everything fine",
  ];

  for (const text of NEGATIVE) {
    it(`no hits for ${JSON.stringify(text)}`, () => {
      expect(scanHeuristics(text)).toEqual([]);
    });
  }

  it("markers next to real failures still fire on the failure only", () => {
    const hits = scanHeuristics(
      "[vc-9f3a2b] zsh: command not found: vellum-command",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.class === "env")).toBe(true);
    expect(hits.some((h) => h.matched.includes("[vc-"))).toBe(false);
  });
});
