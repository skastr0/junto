/**
 * Typed scenario shape + helpers for e2e/fakes/bin/codexbar.
 *
 * A scenario is a JSON file pointed at by FAKE_CODEXBAR_SCENARIO:
 * {mode: "healthy", quotas?} prints a ProviderQuota[]-shaped payload
 * (defaults to one healthy codex row); {mode: "malformed"} prints non-JSON
 * stdout so the product degrades to a typed parse-error. "codexbar missing"
 * needs no scenario at all — just omit e2e/fakes/bin from PATH, or omit this
 * binary specifically via a PATH built without it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FakeCodexbarQuotaWindow {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAt?: string;
  readonly resetDescription?: string;
}

export interface FakeCodexbarQuota {
  readonly provider: string;
  readonly source?: string;
  readonly accountEmail?: string;
  readonly loginMethod?: string;
  readonly usage: {
    readonly primary?: FakeCodexbarQuotaWindow;
    readonly secondary?: FakeCodexbarQuotaWindow;
    readonly tertiary?: FakeCodexbarQuotaWindow;
    readonly updatedAt?: string;
  };
}

export type FakeCodexbarScenario =
  | { readonly mode: "healthy"; readonly quotas?: ReadonlyArray<FakeCodexbarQuota> }
  | { readonly mode: "malformed" };

/** Write a scenario file for FAKE_CODEXBAR_SCENARIO to point at. */
export const writeScenario = async (path: string, scenario: FakeCodexbarScenario): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(scenario), "utf8");
};
