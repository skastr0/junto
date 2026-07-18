import * as NodeCommandExecutor from "@effect/platform-node/NodeCommandExecutor";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvedSpawnEnv, resolvedSpawnEnvSync } from "../adapters/exec";
import { ProcessSpawnerLive } from "./process-spawner";
import { SshTransportConfig, SshTransportLayer } from "./service";

const NodeExecutorLive = NodeCommandExecutor.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
);

const NodeProcessSpawnerLive = ProcessSpawnerLive.pipe(
  Layer.provide(NodeExecutorLive),
);

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
      controlDir: join(homedir(), ".vellum", "ssh"),
      envExecutable: "/usr/bin/env",
      sshExecutable: "/usr/bin/ssh",
      environment: allowedSshEnvironment(environment),
      maxConcurrentDials: 6,
      maxConcurrentDialsPerEndpoint: 2,
    })),
  ),
);

export const SshTransportLive = SshTransportLayer.pipe(
  Layer.provide(NodeProcessSpawnerLive),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(SshConfigLive),
);
