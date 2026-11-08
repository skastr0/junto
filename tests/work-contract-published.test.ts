/**
 * The published work schemas are the contract as it is now: a change to an
 * op's arguments or answer that is not republished fails here, before the
 * native CLI's parity tests read a stale file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLISH_COMMAND, PUBLISHED_DIR, publishedWorkSchemas } from "../src/contract/work/publish";

const generated = publishedWorkSchemas();
const onDisk = existsSync(PUBLISHED_DIR) ? readdirSync(PUBLISHED_DIR).filter((name) => name.endsWith(".json")) : [];

describe("published work schemas", () => {
  it("publishes every op of every group, and nothing else", () => {
    expect(onDisk.sort(), `run ${PUBLISH_COMMAND}`).toEqual([...generated.keys()].sort());
  });

  it.each([...generated])("%s is what the contract generates", (name, text) => {
    const path = join(PUBLISHED_DIR, name);
    expect(existsSync(path) ? readFileSync(path, "utf8") : undefined, `run ${PUBLISH_COMMAND}`).toBe(text);
  });
});
