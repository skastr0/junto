/**
 * Isolated real-Devin mail notice [real-harness] — disjoint from fake-tui crew specs.
 *
 * Seeds only credentials.toml into the E2E sandbox HOME. Does not write
 * ~/.vellum-command/state/vellum-command.db. typedNoticeQualified stays false.
 * Process-bound msg.list + durable readAt is the Computer Use hold once this
 * occupy/delivery fixture is green.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, launchVellum, test } from "../harness/launch";
import { crewPlayFactory } from "../harness/crew-fixture";
import { HARNESS_MAIL_TRANSPORT } from "../../src/shared/managed-terminal-templates";
import {
  ISOLATED_DEVIN_CREDENTIAL_REL,
  ISOLATED_DEVIN_MAIL_CANVAS,
  ISOLATED_DEVIN_RECEIVER_ID,
  isolatedDevinMailDoc,
  resolveOperatorDevinBinary,
  seedIsolatedDevinAppHome,
} from "../harness/isolated-devin-mail-fixture";

const operatorHome = homedir();
const operatorCred = join(operatorHome, ISOLATED_DEVIN_CREDENTIAL_REL);

test("isolated Devin [real-harness]: credential seed does not flip qualification", async () => {
  test.setTimeout(120_000);
  if (!existsSync(operatorCred)) {
    test.skip(true, "no operator Devin credentials.toml to seed");
  }
  if (resolveOperatorDevinBinary(process.env.PATH ?? "") === undefined) {
    test.skip(true, "real devin binary not on PATH");
  }
  expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(false);

  const vellum = await launchVellum({
    seedCanvases: { [ISOLATED_DEVIN_MAIL_CANVAS]: isolatedDevinMailDoc() },
    afterSeed: async (sandbox) => {
      const prepared = await seedIsolatedDevinAppHome(
        sandbox,
        operatorHome,
        process.env.PATH ?? "",
      );
      if (!prepared.ok) throw new Error(prepared.limitation);
      expect(prepared.env.HOME).toBe(sandbox.homeDir);
      expect(prepared.env.HOME).not.toBe(operatorHome);
      expect(prepared.seeded.copied).toContain(ISOLATED_DEVIN_CREDENTIAL_REL);
      expect(existsSync(join(sandbox.homeDir, ISOLATED_DEVIN_CREDENTIAL_REL))).toBe(true);
      expect(
        existsSync(join(sandbox.homeDir, ".local/share/devin/cli/sessions.db")),
      ).toBe(false);
    },
  });
  try {
    const { page, sandbox } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await expect(
      page.locator(`.react-flow__node[data-id="${ISOLATED_DEVIN_RECEIVER_ID}"]`),
    ).toBeVisible({ timeout: 20_000 });
    expect(existsSync(join(sandbox.homeDir, ISOLATED_DEVIN_CREDENTIAL_REL))).toBe(true);
    expect(HARNESS_MAIL_TRANSPORT.devin.typedNoticeQualified).toBe(false);
  } finally {
    await vellum.close();
  }
});
