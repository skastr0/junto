import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { launchJunto } from "../harness/launch";

/**
 * The proof #650 asks for: a crashed process leaves a minidump on this machine.
 *
 * The app starts Crashpad before its first window (src/app/observability/crash-reporter.ts),
 * so every window, core, terminal and renderer created after that is covered.
 * This spec crashes one renderer through CDP, the way a native fault would end
 * it, and waits for Crashpad to write the dump under `app.getPath("crashDumps")`.
 * Nothing is uploaded: `uploadToServer` is false and there is no submit URL.
 */
test("a crashed renderer leaves a local minidump", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({});
  try {
    const crashDumps = await junto.app.evaluate(({ app }) => app.getPath("crashDumps"));
    expect(crashDumps).toContain(junto.sandbox.userDataDir);
    const client = await junto.page.context().newCDPSession(junto.page);
    // The target goes away with the command; the promise rejects and that is
    // the crash landing, not a failure of the check.
    await client.send("Page.crash").catch(() => undefined);
    await expect
      .poll(
        async () => {
          const names = await readdir(crashDumps, { recursive: true }).catch(() => [] as Array<string>);
          return names.filter((name) => name.endsWith(".dmp")).length;
        },
        { timeout: 90_000, intervals: [1_000, 2_000] },
      )
      .toBeGreaterThan(0);
  } finally {
    await junto.close();
  }
});
