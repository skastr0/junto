// S7 V4: @effect/platform-node/* stays separate package (lockstep with effect@4).
// Map + platform/* consolidations: src/cli/effect-v4-import-map.ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer } from "effect";
import { resolveJuntoHome } from "@shared/junto-home";
import { resolvedSpawnEnv, resolvedSpawnEnvSync } from "../adapters/exec";
import { sshMuxControlDir } from "./control-dir";
import { ProcessSpawnerLive } from "./process-spawner";
import { SshTransportConfig, SshTransportLayer } from "./service";

export const OPENSSH_CLIENT_EXECUTABLE = "/usr/bin/ssh";

const allowedSshEnvironment = (source: NodeJS.ProcessEnv): Readonly<Record<string, string>> => {
  const allowed: Record<string, string> = {};
  const exact = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "LANG",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "TMPDIR",
    "XDG_CONFIG_HOME",
  ]);
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (exact.has(name) || name.startsWith("LC_"))) {
      allowed[name] = value;
    }
  }
  return Object.freeze(allowed);
};

const SshConfigLive = Layer.effect(
  SshTransportConfig,
  Effect.tryPromise(() => resolvedSpawnEnv()).pipe(
    Effect.orElseSucceed(() => resolvedSpawnEnvSync()),
    Effect.map((environment) => ({
      controlDir: sshMuxControlDir(resolveJuntoHome()),
      envExecutable: "/usr/bin/env",
      sshExecutable: OPENSSH_CLIENT_EXECUTABLE,
      environment: allowedSshEnvironment(environment),
      maxConcurrentDials: 6,
      maxConcurrentDialsPerEndpoint: 2,
    })),
  ),
);

export const SshTransportLive = SshTransportLayer.pipe(
  Layer.provide(ProcessSpawnerLive),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(SshConfigLive),
);
