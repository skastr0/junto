import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceCapabilities } from "@shared/entities";

// A private source (tower/quasar/booth) is "configured" when its SDK would
// resolve a target: an env var or the SDK's own config file. Detection
// mirrors each SDK's resolution order (env -> config file) and never probes
// the network. An unconfigured source is skipped by the snapshot fan-out and
// hidden by the renderer — the station falls back to nothing, not to error
// badges. Hermes is not gated here: it is a public CLI, present or not.
type Env = Record<string, string | undefined>;

const towerConfigured = (env: Env, home: string): boolean =>
  Boolean(env.TOWER_CONTROL_URL || env.TOWER_CONTROL_TOKEN) ||
  existsSync(join(home, ".tower-control", "config.json"));

const quasarConfigured = (env: Env, home: string): boolean =>
  Boolean(env.QUASAR_SERVER_URL) ||
  existsSync(env.QUASAR_CONFIG ?? join(home, ".config", "quasar", "config.json"));

const boothConfigured = (env: Env, home: string): boolean =>
  Boolean(env.BOOTH_API_URL || env.BOOTH_CONTROL_TOKEN || env.BOOTH_CONTROL_TOKEN_FILE) ||
  existsSync(env.BOOTH_CONTROL_CONFIG ?? join(home, ".booth-control", "config.json"));

export const detectSourceCapabilities = (
  env: Env = process.env,
  home: string = homedir(),
): SourceCapabilities => ({
  tower: towerConfigured(env, home),
  quasar: quasarConfigured(env, home),
  booth: boothConfigured(env, home),
});
