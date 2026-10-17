import { describe, expect, it } from "vitest";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities";
import { HARNESS_RECORDS, harnessRecordFor } from "../src/shared/harness-records";
import { HARNESS_IDS, templateFor } from "../src/shared/managed-terminal-templates";
import { GROK_MIN_POST_SPAWN_MS } from "../src/main/junto/term/drive/managed-terminal-drive";
import { BRACKETED_PASTE_HARNESSES } from "../src/main/junto/term/drive/mail-readiness";
import { harnessRuntimeRecordFor } from "../src/main/junto/term/harness-record";
import { rulePackFor } from "../src/main/junto/term/agent-state/rules";

describe("harness records", () => {
  it("joins template, capabilities, params and PTY profile for every harness", () => {
    expect(Object.keys(HARNESS_RECORDS).sort()).toEqual([...HARNESS_IDS].sort());
    for (const harness of HARNESS_IDS) {
      const record = HARNESS_RECORDS[harness];
      expect(record.harness).toBe(harness);
      expect(record.template).toBe(templateFor(harness));
      expect(record.capabilities).toBe(HARNESS_CAPABILITIES[harness]);
      expect(record.params.harness).toBe(harness);
      expect(harnessRuntimeRecordFor(harness)?.rulePack).toBe(rulePackFor(harness));
    }
  });

  it("refuses ids that name no template", () => {
    expect(harnessRecordFor("not-a-harness")).toBeUndefined();
    expect(harnessRecordFor(undefined)).toBeUndefined();
    expect(harnessRuntimeRecordFor("not-a-harness")).toBeUndefined();
  });

  it("keeps the PTY facts the drive ladders encoded", () => {
    expect([...BRACKETED_PASTE_HARNESSES].sort()).toEqual(
      ["agy", "amp", "claude", "codex", "devin", "fx", "grok", "hermes", "kimi", "muse", "omp", "pi"],
    );
    const pty = (harness: (typeof HARNESS_IDS)[number]) => HARNESS_RECORDS[harness].pty;
    expect(HARNESS_IDS.filter((h) => pty(h).typingReady === "composer")).toEqual(["amp"]);
    expect(HARNESS_IDS.filter((h) => pty(h).typingReady === "signal")).toEqual(["hermes"]);
    expect(HARNESS_IDS.filter((h) => pty(h).multilinePasteSticks)).toEqual(["hermes"]);
    expect(HARNESS_IDS.filter((h) => pty(h).clipboardImageGuard)).toEqual(["grok"]);
    expect(HARNESS_IDS.filter((h) => pty(h).postSpawnSettleMs !== undefined)).toEqual(["grok"]);
    expect(pty("grok").postSpawnSettleMs).toBe(GROK_MIN_POST_SPAWN_MS);
  });
});
