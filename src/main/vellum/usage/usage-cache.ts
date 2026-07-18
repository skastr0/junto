import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageState } from "@shared/usage";

// Last-good usage snapshot for instant HUD paint on app start. The first
// live codexbar poll can take tens of seconds; without this the top bar
// sits empty until vendors answer.

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
    // Only restore a useful paint — empty or all-failed caches are noise.
    const hasQuotas = parsed.snapshots.some(
      (snapshot) => snapshot.ok && Array.isArray(snapshot.quotas) && snapshot.quotas.length > 0,
    );
    return hasQuotas ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const writeUsageCache = (state: UsageState): void => {
  if (skipDisk()) return;
  const hasQuotas = state.snapshots.some(
    (snapshot) => snapshot.ok && Array.isArray(snapshot.quotas) && snapshot.quotas.length > 0,
  );
  if (!hasQuotas) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(state), "utf8");
  } catch {
    // Cache is best-effort — never fail a poll on disk errors.
  }
};
