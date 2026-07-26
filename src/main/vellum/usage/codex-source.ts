import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { UsageSnapshot } from "@shared/usage";
import type { UsageSource } from "./usage-source";

// Codex plan limits are NOT in OTLP (verified absent). The live path is a
// /status grid scrape which is not implemented yet. This source is an honest
// stub: detect when ~/.codex exists, emit no quota rows, never claim limits.

const CODEX_HOME = (): string => join(homedir(), ".codex");

const detectCodex = async (): Promise<boolean> => {
  try {
    return existsSync(CODEX_HOME());
  } catch {
    return false;
  }
};

const fetchCodex = async (): Promise<UsageSnapshot> => {
  const fetchedAt = new Date().toISOString();
  if (!(await detectCodex())) {
    return {
      source: "codex",
      fetchedAt,
      ok: false,
      reason: "source-missing",
      error: "~/.codex not found",
      quotas: [],
    };
  }
  // Present but no machine-readable plan limits yet. Empty ok envelope so
  // doctor can list "codex (limits pending)" without painting a fake bar.
  return {
    source: "codex",
    fetchedAt,
    ok: true,
    quotas: [],
    // Carried via a sentinel error-free empty: UI skips empty quotas.
    // Doctor uses detect; detail notes partial capability elsewhere.
  };
};

/** Capability note for doctor / HUD partial labeling. */
export const CODEX_LIMITS_STATUS = "unknown — /status scrape not live; OTLP has tokens only (not wired)";

export const codexSource: UsageSource = {
  id: "codex",
  detect: Effect.promise(detectCodex),
  fetch: Effect.promise(fetchCodex),
};
