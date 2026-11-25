/**
 * The shared signed-release fixture (tests/fixtures/linux-release): the same
 * bytes the Rust bootstrap verifier reads. Every case is admitted or refused
 * with the exact same sentence by both verifiers, so they cannot drift.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  verifyLinuxDesktopRelease,
  type LinuxDesktopReleaseTrust,
} from "../src/shared/linux-desktop-release-crypto";

interface Case {
  readonly name: string;
  readonly file: string;
  readonly trust?: string;
  readonly now: string;
  readonly expect: { readonly ok: true; readonly version: string } | { readonly ok: false; readonly message: string };
}

const fixture = (path: string) => new URL(`./fixtures/linux-release/${path}`, import.meta.url);
const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(fixture(path), "utf8"));

describe("the shared signed-release fixture", () => {
  it("is admitted or refused exactly as the native bootstrap words it", async () => {
    const cases = (await read("cases.json")) as readonly Case[];
    expect(cases.length).toBeGreaterThan(10);
    for (const entry of cases) {
      const trust = (await read(entry.trust ?? "trust.json")) as LinuxDesktopReleaseTrust;
      const value = await read(entry.file);
      let observed:
        | { readonly ok: true; readonly version: string }
        | { readonly ok: false; readonly message: string };
      try {
        const verified = verifyLinuxDesktopRelease(value, { trust, now: entry.now });
        observed = { ok: true, version: verified.version };
      } catch (error) {
        observed = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      expect(observed, entry.name).toEqual(entry.expect);
    }
  });
});
