import {
  type LocalAcpProcessChild,
  type SpawnedAcpChild,
} from "../../src/main/vellum/chat/acp-client";
import { admitChildProcess } from "../../src/main/vellum/process-signal";

/** Test-only mint at the fake spawn boundary, mirroring HermesPlane. */
export const spawnedLocalAcp = (
  child: LocalAcpProcessChild,
): SpawnedAcpChild => ({
  kind: "local-process",
  child,
  process: admitChildProcess({ source: "test.chat-acp", child }),
});
