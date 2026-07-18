import * as NodeCommandExecutor from "@effect/platform-node/NodeCommandExecutor";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Layer } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProcessSpawnerLive } from "./process-spawner";
import { SshTransportConfig, SshTransportLayer } from "./service";

const NodeExecutorLive = NodeCommandExecutor.layer.pipe(
  Layer.provide(NodeFileSystem.layer),
);

const NodeProcessSpawnerLive = ProcessSpawnerLive.pipe(
  Layer.provide(NodeExecutorLive),
);

export const SshTransportLive = SshTransportLayer.pipe(
  Layer.provide(NodeProcessSpawnerLive),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(
    Layer.succeed(SshTransportConfig, {
      controlDir: join(homedir(), ".vellum", "ssh"),
      maxConcurrentDials: 6,
    }),
  ),
);
