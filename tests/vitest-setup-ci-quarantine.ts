/**
 * Skips the CI-quarantined tests the lane runner hands over in
 * JUNTO_CI_QUARANTINE (see scripts/ci-quarantine.ts). Unset, as in every
 * local and targeted run, this file does nothing.
 */
import { relative } from "node:path";
import { beforeEach } from "vitest";
import type { QuarantineEntry } from "../scripts/ci-quarantine";

const raw = process.env.JUNTO_CI_QUARANTINE;
const entries: readonly QuarantineEntry[] = raw ? (JSON.parse(raw) as QuarantineEntry[]) : [];

if (entries.length > 0) {
  beforeEach((context) => {
    const file = relative(process.cwd(), context.task.file.filepath);
    const entry = entries.find(
      (candidate) => candidate.file === file && candidate.test === context.task.fullTestName,
    );
    if (entry) context.skip(`ci-quarantine: ${entry.owner}, ${entry.reason}`);
  });
}
