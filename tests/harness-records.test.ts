import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities";
import { HARNESS_RECORDS, harnessRecordFor, versionVerdict } from "../src/shared/harness-records";
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
      expect(harnessRuntimeRecordFor(harness)?.session === undefined, harness).toBe(harness === "junto-overseer");
    }
  });

  it("lists models with the template's binary, except Cursor's agent alias", () => {
    for (const harness of HARNESS_IDS) {
      const list = harnessRuntimeRecordFor(harness)!.models;
      if (list.kind !== "command" || list.binary === undefined) continue;
      expect(harness).toBe("cursor");
      expect(list.binary).toBe("agent");
    }
  });

  it("finds the session after spawn only for harnesses that never print or take one", () => {
    const after = HARNESS_IDS.filter((harness) => harnessRuntimeRecordFor(harness)!.session?.spawned !== undefined);
    expect(after.sort()).toEqual(["agy", "codex", "fx", "muse", "omp"]);
    for (const harness of after) {
      expect(templateFor(harness).argvSpec.sessionIdFlag, harness).toBeUndefined();
    }
  });

  it("declares a verified range that covers every version the corpus captured", () => {
    const corpus = join(process.cwd(), "tests", "pty-e2e", "corpus");
    for (const harness of HARNESS_IDS) {
      const verified = harnessRecordFor(harness)!.verified;
      expect(verified === undefined, harness).toBe(harness === "junto-overseer");
      if (verified === undefined) continue;
      expect(versionVerdict(verified, verified.from), harness).toBe("verified");
      expect(versionVerdict(verified, verified.through), harness).toBe("verified");
      const manifest = join(corpus, harness, "manifest.json");
      if (!existsSync(manifest)) continue;
      const versions = [...readFileSync(manifest, "utf8").matchAll(/"[a-zA-Z]*[vV]ersion"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
      for (const version of versions) expect(versionVerdict(verified, version), `${harness} ${version}`).toBe("verified");
    }
  });

  it("reads an installed version against the verified range", () => {
    const range = { from: "0.154.0", through: "0.162.1" };
    expect(versionVerdict(range, "codex-cli 0.162.1")).toBe("verified");
    expect(versionVerdict(range, "codex-cli 0.163.0")).toBe("newer");
    expect(versionVerdict(range, "codex-cli 0.99.9")).toBe("older");
    expect(versionVerdict({ from: "0.20.4", through: "0.21.0" }, "Hermes Agent v0.21.6+675.g79b45d1 (2026.9.24)")).toBe("newer");
    expect(versionVerdict({ from: "0.0.1789401648", through: "0.0.1789401648" }, "0.0.1792195263-g037e53")).toBe("newer");
    expect(versionVerdict(range, "")).toBe("unknown");
    expect(versionVerdict(range, undefined)).toBe("unknown");
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
