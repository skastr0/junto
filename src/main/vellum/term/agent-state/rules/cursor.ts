/**
 * Cursor Agent seat rules — grid-primary (OSC title is static).
 * Patterns from docs/research/agent-cli-sweep/cursor.md
 * (rewritten; not vendored). Alt-screen snapshots already use buffer.active.
 */

import type { SeatRulePack } from "../types";

export const cursorRules: SeatRulePack = {
  harness: "cursor",
  version: "2026.08.17.1",
  rules: [
    {
      id: "write_file_approval",
      state: "attention",
      priority: 1200,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["write to this file?"] },
          { contains: ["proceed (y)"] },
          { contains: ["reject & propose changes"] },
        ],
      },
    },
    {
      id: "approval_prompt",
      state: "attention",
      priority: 1190,
      region: "whole_recent",
      visibleAttention: true,
      matchers: {
        any: [
          { contains: ["waiting for approval"] },
          { contains: ["run this command?"] },
          { contains: ["run (once) (y)"] },
          { contains: ["run this command outside the sandbox?"] },
        ],
      },
    },
    {
      id: "stop_hint_working",
      state: "working",
      priority: 200,
      region: "bottom_non_empty_lines",
      regionN: 6,
      visibleWorking: true,
      matchers: {
        contains: ["ctrl+c to stop"],
      },
    },
    {
      id: "background_task_status_working",
      state: "working",
      priority: 190,
      region: "bottom_non_empty_lines",
      regionN: 5,
      visibleWorking: true,
      matchers: {
        regex: ["\\b[1-9]\\d*\\s+background tasks\\b"],
      },
    },
    {
      id: "spinner_working",
      state: "working",
      priority: 180,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleWorking: true,
      matchers: {
        lineRegex: ["[\\u2800-\\u28FF]"],
      },
    },
    {
      id: "welcome_idle",
      state: "idle",
      priority: 120,
      region: "bottom_non_empty_lines",
      regionN: 8,
      visibleIdle: true,
      matchers: {
        any: [
          { contains: ["plan, search, build anything"] },
          { contains: ["add a follow-up"] },
        ],
        not: [
          { contains: ["ctrl+c to stop"] },
          { contains: ["run this command?"] },
          { contains: ["proceed (y)"] },
        ],
      },
    },
  ],
};
