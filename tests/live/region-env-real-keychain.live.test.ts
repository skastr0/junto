/**
 * LIVE, skipped by default: reads ONE real macOS Keychain item through the
 * real resolver. Run it by hand, naming the item you already have:
 *
 *   JUNTO_LIVE_KEYCHAIN_SERVICE="<service of your existing item>" \
 *     bunx vitest run tests/live/region-env-real-keychain.live.test.ts
 *
 * Optional: JUNTO_LIVE_KEYCHAIN_ACCOUNT="<account>" to narrow the lookup.
 *
 * It reads the item in place and writes nothing. macOS may ask you to allow
 * access. The value is never printed: the test reports its length only.
 */
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { makeEnvSourceResolver } from "../../src/main/junto/region-env/sources";
import { runTool } from "../../src/main/junto/region-env/tool";

const service = process.env.JUNTO_LIVE_KEYCHAIN_SERVICE;
const account = process.env.JUNTO_LIVE_KEYCHAIN_ACCOUNT;

describe.skipIf(!service || process.platform !== "darwin")(
  "LIVE: a real Keychain item becomes a region variable",
  () => {
    it("reads the operator's existing item by service, in place", async () => {
      const resolver = makeEnvSourceResolver({
        run: runTool,
        platform: process.platform,
        home: homedir(),
        secrets: { backend: "unavailable", description: "not used", read: () => undefined },
        toolEnv: async () => process.env,
      });
      const out = await resolver.resolve(
        {
          id: "live",
          kind: "keychain",
          name: "OP_SERVICE_ACCOUNT_TOKEN",
          service: service!,
          ...(account ? { account } : {}),
        },
        { resolved: () => undefined },
      );
      if (out.status !== "ok") {
        // The reason is plain words and holds no secret.
        throw new Error(`keychain source did not resolve: ${out.status}: ${out.reason}`);
      }
      const value = out.values.OP_SERVICE_ACCOUNT_TOKEN ?? "";
      expect(Object.keys(out.values)).toEqual(["OP_SERVICE_ACCOUNT_TOKEN"]);
      expect(value.length).toBeGreaterThan(0);
      expect(value).not.toMatch(/\n$/u);
      console.log(`resolved OP_SERVICE_ACCOUNT_TOKEN from the Keychain (${String(value.length)} characters)`);
    }, 30_000);
  },
);
