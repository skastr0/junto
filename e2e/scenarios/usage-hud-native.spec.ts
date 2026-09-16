/**
 * Native usage HUD coverage. There is no external CLI fake any more — the
 * seam under test is the product's own durable one: the `usage_state` row in
 * the sandbox's canonical SQLite database. UsageCache paints it at boot and
 * UsageService keeps its quotas when a live poll fails (in the sandboxed
 * PATH/HOME every native source fails closed to an ok:false envelope), so a
 * pre-launch seed is exactly what a real session sees after its first
 * successful commit.
 *
 * Covered here, per the HUD contract:
 *   - multi-provider paint: one cell per quota row on ok snapshots
 *   - ok:false envelopes contribute no cells (fail open, never error chrome)
 *   - cache-painted state is honest: stale dot + "stale" accessible name
 *     (the seeded snapshots carry dataConfidence "stale-cache" for the same
 *     reason)
 *   - a failed live refresh keeps last-good on screen instead of wiping it
 *   - with no last-good at all, the rail hides entirely (fail open)
 */
import type { UsageState } from "../../src/shared/usage";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";

const iso = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Multi-provider last-good: three quota rows across four snapshots, one
 * of them a failing ok:false envelope that must paint nothing. */
const MULTI_PROVIDER_STATE: UsageState = {
  snapshots: [
    {
      source: "claude",
      fetchedAt: iso(4),
      ok: true,
      dataConfidence: "stale-cache",
      quotas: [
        {
          provider: "claude",
          source: "oauth",
          status: "ok",
          account: "ops@example.com",
          plan: "max",
          updatedAt: iso(4),
          windows: [
            { label: "primary", usedPercent: 77, windowMinutes: 300 },
            { label: "secondary", usedPercent: 12, windowMinutes: 10_080 },
          ],
        },
      ],
    },
    {
      source: "codex",
      fetchedAt: iso(4),
      ok: true,
      dataConfidence: "stale-cache",
      quotas: [
        {
          provider: "codex",
          source: "oauth",
          status: "ok",
          updatedAt: iso(4),
          windows: [{ label: "primary", usedPercent: 42, windowMinutes: 300 }],
        },
      ],
    },
    {
      source: "hermes",
      fetchedAt: iso(4),
      ok: true,
      dataConfidence: "stale-cache",
      quotas: [
        {
          provider: "hermes",
          source: "session",
          status: "ok",
          updatedAt: iso(4),
          windows: [{ label: "primary", usedPercent: 91, windowMinutes: 300 }],
        },
      ],
    },
    {
      source: "grok",
      fetchedAt: iso(4),
      ok: false,
      reason: "cli-missing",
      error: "no grok session on this machine",
      quotas: [],
    },
  ],
  lastLiveAt: iso(4),
};

const waitForBridge = async (handle: JuntoHandle): Promise<void> => {
  await expect
    .poll(() =>
      handle.page.evaluate(
        () => typeof window.vellumCommand?.refreshUsage === "function",
      ),
    )
    .toBe(true);
};

test("usage HUD paints seeded multi-provider quotas and marks cache confidence honestly", async () => {
  const handle = await launchJunto({ seedUsage: MULTI_PROVIDER_STATE });
  try {
    await expect(handle.page.locator(".react-flow")).toBeVisible({
      timeout: 30_000,
    });
    await waitForBridge(handle);

    // One cell per quota row across ok snapshots; the ok:false grok envelope
    // contributes nothing.
    await expect(handle.page.locator(".usage-hud")).toBeVisible({
      timeout: 30_000,
    });
    await expect(handle.page.locator(".usage-hud__cell")).toHaveCount(3);

    // Bars render the worst window per quota, honestly filled.
    const fills = await handle.page
      .locator(".usage-hud__cell .usage-hud__bar > i")
      .evaluateAll((bars) =>
        bars.map((bar) => ({
          width: (bar as HTMLElement).style.width,
          background: (bar as HTMLElement).style.background,
        })),
      );
    // One bar per cell, painted from the worst window: 77% amber,
    // 42% calm green, 91% crimson.
    expect(fills.map((fill) => fill.width)).toEqual(["77%", "42%", "91%"]);
    expect(new Set(fills.map((fill) => fill.background)).size).toBe(3);

    // Cache-painted confidence is spoken out loud: stale marker + name.
    await expect(handle.page.locator(".usage-hud.is-stale")).toHaveCount(1);
    await expect(handle.page.locator(".usage-hud__stale-dot")).toHaveCount(1);
    await expect(
      handle.page.getByRole("button", { name: /Provider limits, stale/ }),
    ).toHaveCount(1);

    // A failed live refresh keeps last-good painted (never wipes the rail).
    await handle.page.evaluate(() => window.vellumCommand?.refreshUsage?.());
    await expect(handle.page.locator(".usage-hud__cell")).toHaveCount(3, {
      timeout: 30_000,
    });
  } finally {
    await handle.close();
  }
});

test("usage HUD hides entirely when there is no last-good and live fails", async () => {
  // No seedUsage: empty cache, and every native source fails closed inside
  // the sandboxed HOME/PATH — fail open means no chrome, not an error chip.
  const handle = await launchJunto();
  try {
    await expect(handle.page.locator(".react-flow")).toBeVisible({
      timeout: 30_000,
    });
    await waitForBridge(handle);
    await handle.page.evaluate(() => window.vellumCommand?.refreshUsage?.());
    await expect(handle.page.locator(".usage-hud")).toHaveCount(0, {
      timeout: 30_000,
    });
  } finally {
    await handle.close();
  }
});
