import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasUsageQuotas, type UsageState } from "@shared/usage";

// Disk last-good for the usage plane. Codexbar live polls are slow (vendor
// web); cold start must still paint the HUD from this file. Never read
// CodexBar.app private Application Support — only our own normalized state.

const CACHE_DIR = join(homedir(), ".vellum", "cache");
const CACHE_PATH = join(CACHE_DIR, "usage-state.json");

const skipDisk = (): boolean =>
  process.env.VITEST === "true" || process.env.NODE_ENV === "test";

export const readUsageCache = (): UsageState | undefined => {
  if (skipDisk()) return undefined;
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as UsageState;
    if (!parsed || !Array.isArray(parsed.snapshots)) return undefined;
    if (!hasUsageQuotas(parsed)) return undefined;
    // Always surface as stale until a live poll replaces it this session.
    return {
      snapshots: parsed.snapshots,
      stale: true,
      ...(parsed.lastLiveAt !== undefined ? { lastLiveAt: parsed.lastLiveAt } : {}),
    };
  } catch {
    return undefined;
  }
};

export const writeUsageCache = (state: UsageState): void => {
  if (skipDisk()) return;
  // Only persist paint-worthy state — never clobber last-good with a fail envelope.
  if (!hasUsageQuotas(state)) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        snapshots: state.snapshots,
        lastLiveAt: state.lastLiveAt ?? new Date().toISOString(),
        stale: true,
      } satisfies UsageState),
      "utf8",
    );
  } catch {
    // Cache is best-effort — never fail a poll on disk errors.
  }
};
