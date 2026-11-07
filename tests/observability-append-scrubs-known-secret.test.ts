/**
 * A secret only the core knows must not reach the ring through a main-side row.
 *
 * Main writes its rows with what main knows: its own environment and the
 * credential shapes. It holds no seat credential, so the registry of known
 * values is not in main at all (credentials/known-secrets.ts is the core's).
 * The row it forwards is scrubbed again in the core, where the registry lives,
 * and that second scrub is what this test proves: the same row, before and
 * after it crosses into the process that can recognise the value.
 */
import { afterEach, describe, expect, test } from "vitest";
import { knownSecretValues, scrubMessage } from "../src/main/junto/credentials/scrub";
import {
  registerKnownSecrets,
  registeredSecretValues,
  releaseKnownSecrets,
} from "../src/main/junto/credentials/known-secrets";
import { appendScrubbed, makeObservabilityRing } from "../src/main/junto/observability/ring";
import { makeTestLog } from "./support/test-log";

const { log: mainLog } = makeTestLog();

/** Eight characters, letters and a digit: no credential shape matches it. */
const SECRET = "zebra-42";
const OWNER = "seat:test-binding@test-epoch";

afterEach(() => {
  releaseKnownSecrets(OWNER);
});

describe("a registered secret on the main path", () => {
  test("main cannot scrub it, and the core's ring scrubs it where the registry lives", () => {
    // This process as main: no registry, only its environment and the shapes.
    const row = mainLog.writeLog({
      level: "error",
      source: "system",
      message: `the seat did not start: ${SECRET} in its environment`,
    });
    expect(knownSecretValues().includes(SECRET), "main knows no such value").toBe(false);
    expect(row.message, "main's own row cannot recognise the value").toContain(SECRET);

    // The same process as the core: the registry holds the value the seat was
    // given, and the row main forwarded is scrubbed again on arrival.
    registerKnownSecrets(OWNER, [SECRET]);
    const entry = appendScrubbed({
      level: row.level,
      source: row.source,
      message: row.message,
      ts: 1,
      spans: [`seat ${SECRET}`],
    });
    expect(entry.message, "the core's ring holds no secret").not.toContain(SECRET);
    expect(entry.message).toContain("[redacted]");
    expect(entry.spans?.join(" ") ?? "").not.toContain(SECRET);
    // A scrub in the core is given the registry's values; it never finds them.
    const known = knownSecretValues({ registered: registeredSecretValues() });
    expect(scrubMessage(`x ${SECRET} y`, known)).not.toContain(SECRET);
  });

  test("a credential shape is scrubbed in main too, with no registry at all", () => {
    const credential = `junto-seat-${"aB3".repeat(14)}x`;
    const row = mainLog.writeLog({ level: "error", source: "system", message: `denied ${credential}` });
    expect(row.message).not.toContain(credential);
    expect(row.message).toContain("[redacted]");
  });

  test("the ring appends what it is given, so the scrub is the door", () => {
    const ring = makeObservabilityRing(4);
    const raw = ring.append({ level: "info", source: "system", message: `holds ${SECRET}` });
    expect(raw.message).toContain(SECRET);
  });
});
