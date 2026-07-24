import type { ToolSource } from "prism";
import {
  ArtifactPublishInput,
  WorkCommandResult,
  type ArtifactPublishInput as ArtifactPublishInputType,
} from "../schemas/tool-schemas.ts";
import { callWork } from "./shared/work-client.ts";

export default {
  name: "artifact_publish",
  description:
    "Publish an artifact to a connected artifacts sink. Parts are text or base64 raw. Artifacts never block the factory.",
  input: ArtifactPublishInput,
  output: WorkCommandResult,
  handle(input) {
    const args = input as ArtifactPublishInputType;
    return callWork("artifact.publish", {
      target: args.target,
      parts: args.parts,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.artifactId !== undefined ? { artifactId: args.artifactId } : {}),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    });
  },
} satisfies ToolSource;
