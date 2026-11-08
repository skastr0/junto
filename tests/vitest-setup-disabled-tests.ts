/**
 * Skips the disabled tests the lane runner hands over in JUNTO_DISABLED_TESTS
 * (see scripts/disabled-tests.ts). Unset, as in a targeted run, this file
 * does nothing.
 */
import { relative } from "node:path";
import { beforeEach } from "vitest";
import type { DisabledEntry } from "../scripts/disabled-tests";

const raw = process.env.JUNTO_DISABLED_TESTS;
const entries: readonly DisabledEntry[] = raw ? (JSON.parse(raw) as DisabledEntry[]) : [];

if (entries.length > 0) {
  beforeEach((context) => {
    const file = relative(process.cwd(), context.task.file.filepath);
    const entry = entries.find(
      (candidate) => candidate.file === file && candidate.test === context.task.fullTestName,
    );
    if (entry) context.skip(`disabled: ${entry.owner}, ${entry.reason}`);
  });
}
