import { createHash } from "node:crypto";
import { verdictSubjectHashPayload } from "../../../shared/crew";

/**
 * Canonical subject hash. Every lane derives it here so the gate compares
 * identical bytes; the payload (domain-separated, commit shas normalized) lives
 * in the shared module.
 */
export const subjectHashOf = (
  input:
    | {
        readonly kind: "task";
        readonly installationId: string;
        readonly canvasName: string;
        readonly nodeId: string;
        readonly taskId: string;
        readonly epoch: number;
        readonly commitShas?: ReadonlyArray<string>;
        readonly artifactRefs?: ReadonlyArray<{
          readonly nodeId: string;
          readonly artifactId: string;
        }>;
        readonly claimRefs?: ReadonlyArray<string>;
      }
    | { readonly kind: "commit"; readonly sha: string },
): string =>
  createHash("sha256")
    .update(verdictSubjectHashPayload(input), "utf8")
    .digest("hex");
