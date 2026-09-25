/**
 * Landing captures — NOT a correctness spec. Stages a calm, product-true board
 * of agent seats and captures the surfaces the landing site shows, in bright
 * and dark: the board with ringed seats, the needs-you feed, the focus window,
 * the grid focus, the multi-prompt, and the seats-and-rings gallery.
 *
 *   LANDING_SHOTS_DIR=/durable/path bun run test:e2e:fast e2e/scenarios/landing-captures.spec.ts
 *
 * Harness output is synthetic: each seat runs a tiny script that prints a
 * made-up, harmless session, so no real agent, account, or path appears.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import { templateFor } from "../../src/shared/managed-terminal-templates";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";
import type { GroupNode } from "../../src/shared/canvas";

const SHOTS = process.env.LANDING_SHOTS_DIR ?? join(process.cwd(), "test-results", "landing");
const CANVAS = "studio";
const FRAME = { width: 1600, height: 1000 };
const MINUTE = 60_000;

const region = (id: string, label: string, x: number, y: number, width: number, height: number): GroupNode => ({
  id,
  type: "group",
  label,
  x,
  y,
  width,
  height,
});

const seats: ReadonlyArray<readonly [id: string, label: string, harness: HarnessId, x: number, y: number]> = [
  ["maple", "maple", "claude", 60, 90],
  ["juniper", "juniper", "codex", 380, 90],
  ["pip", "pip", "claude", 60, 250],
  ["olive", "olive", "grok", 380, 250],
  ["basil", "basil", "codex", 800, 90],
  ["clove", "clove", "claude", 1120, 90],
  ["fern", "fern", "pi", 800, 250],
  ["sorrel", "sorrel", "amp", 1120, 250],
];

const agents = seats.map(([id, label, harness, x, y]) =>
  agentTextNode({ id, key: `local:landing-${id}`, label, harness, x, y }),
);

const fixture = canvasDoc(
  [region("app", "App", 20, 20, 680, 360), region("docs", "Docs", 760, 20, 680, 360), ...agents],
  [
    verbEdge("e-maple-juniper", "maple", "juniper", "messages", agents),
    verbEdge("e-maple-pip", "maple", "pip", "messages", agents),
    verbEdge("e-juniper-olive", "juniper", "olive", "messages", agents),
    verbEdge("e-basil-clove", "basil", "clove", "messages", agents),
    verbEdge("e-basil-fern", "basil", "fern", "messages", agents),
    verbEdge("e-juniper-basil", "juniper", "basil", "messages", agents),
  ],
);

// A calm, made-up agent session. Printed slowly so a seat reads as working,
// then it waits on stdin like an idle harness prompt.
const session = (): string => {
  const lines = [
    "session ready in ~/projects/garden",
    "",
    "\\033[2m> tidy the settings page and keep the tests green\\033[0m",
    "",
    "\\033[38;5;73m●\\033[0m Reading src/settings/page.tsx",
    "\\033[38;5;73m●\\033[0m Reading src/settings/form.tsx",
    "\\033[38;5;179m●\\033[0m Editing src/settings/form.tsx  \\033[32m+18\\033[0m \\033[31m-9\\033[0m",
    "\\033[38;5;73m●\\033[0m Running the settings tests",
    "  \\033[32m✓\\033[0m 14 passed",
    "\\033[38;5;141m●\\033[0m Mail to juniper: the form now validates on blur",
    "",
    "Done. The form is split in two and every test passes.",
  ];
  return [
    "#!/bin/sh",
    ...lines.map((line) => `printf '%b\\n' "${line}"; sleep 0.4`),
    "printf '\\n\\033[2m>\\033[0m '",
    "exec cat",
    "",
  ].join("\n");
};

const signal = (over: Partial<AgentSignal> & Pick<AgentSignal, "signalId" | "nodeId" | "kind" | "text">): AgentSignal => ({
  canvasName: CANVAS,
  createdAt: Date.now() - 5 * MINUTE,
  state: "open",
  ...over,
});

const setTheme = async (page: Page, mode: "bright" | "dark"): Promise<void> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  const choice = page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(500);
};

const node = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);

// Click empty canvas just under the board; corners hold the minimap and controls.
const clearSelection = async (page: Page): Promise<void> => {
  await page.keyboard.press("Escape");
  const box = await node(page, "app").boundingBox();
  if (!box) return;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 40);
};

test("landing captures", async () => {
  test.setTimeout(420_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: fixture },
    electronArgs: ["--force-device-scale-factor=2"],
    afterSeed: async (sandbox) => {
      const binDir = seededHarnessBinDir(sandbox);
      await mkdir(binDir, { recursive: true });
      const harnesses = new Set(seats.map(([, , harness]) => harness));
      for (const harness of harnesses) {
        const path = join(binDir, templateFor(harness).argvSpec.binary);
        await writeFile(path, session(), "utf8");
        await chmod(path, 0o755);
      }
    },
  });
  const failures: string[] = [];
  const scene = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      await junto.page.keyboard.press("Escape").catch(() => undefined);
    }
  };

  try {
    const { app, page } = junto;
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(size.width, size.height);
        win.center();
      }
    }, FRAME);
    await expect(node(page, "maple")).toBeVisible({ timeout: 30_000 });

    const push = async (value: AgentSignal): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, payload) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send("junto:agent-signal", payload);
      }, value);
    };

    for (const mode of ["bright", "dark"] as const) {
      await setTheme(page, mode);

      // Grid focus first: opening the grid starts every seat it shows, so the
      // board after it has working rings.
      await scene(`${mode} grid`, async () => {
        await clearSelection(page);
        for (const id of ["maple", "juniper", "pip", "olive"]) {
          await node(page, id).click({ modifiers: ["Shift"] });
        }
        await node(page, "maple").click({ button: "right" });
        await page.getByRole("button", { name: "Open 4 agents in a grid" }).click();
        const grid = page.getByTestId("terminal-grid-focus");
        await expect(grid).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(6_500);
        await page.locator(".terminal-grid__cell").nth(1).click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(SHOTS, `${mode}-grid.png`) });
        await grid.getByRole("button", { name: "Close grid" }).click();
        await expect(grid).toHaveCount(0);
      });

      await scene(`${mode} focus`, async () => {
        await clearSelection(page);
        await node(page, "basil").dblclick();
        const focus = page.locator('[data-focus-surface="1"]');
        await expect(focus).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(6_000);
        await page.screenshot({ path: join(SHOTS, `${mode}-focus.png`) });
        await focus.locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
        await expect(focus).toBeHidden({ timeout: 10_000 });
      });

      if (mode === "bright") {
        await push(signal({
          signalId: "sig-blocked",
          nodeId: "clove",
          kind: "blocked",
          text: "I need the staging database password to run the migration.",
          createdAt: Date.now() - 42 * MINUTE,
        }));
        await push(signal({
          signalId: "sig-escalate",
          nodeId: "pip",
          kind: "escalate",
          text: "Two tests disagree on the date format; I picked ISO 8601 and kept going.",
          createdAt: Date.now() - 18 * MINUTE,
        }));
        await push(signal({
          signalId: "sig-feedback",
          nodeId: "fern",
          kind: "feedback",
          text: "The settings page redesign is ready for a look.",
          createdAt: Date.now() - 7 * MINUTE,
        }));
      }

      // Preambles: one short line over a seat, in its provenance colour.
      // One event per seat; the feed paces a seat's second line.
      await app.evaluate(({ BrowserWindow }, events) => {
        for (const window of BrowserWindow.getAllWindows()) {
          for (const event of events) window.webContents.send("junto:preamble", event);
        }
      }, [
        { preambleId: `${mode}-p1`, canvasName: CANVAS, nodeId: "juniper", text: "reading the settings tests", expiresAt: Date.now() + 120_000, provenance: "agent", action: "tool" },
        { preambleId: `${mode}-p2`, canvasName: CANVAS, nodeId: "maple", text: "mail from juniper", expiresAt: Date.now() + 120_000, provenance: "system", action: "mail-in" },
        { preambleId: `${mode}-p3`, canvasName: CANVAS, nodeId: "basil", text: "splitting the docs build in two", expiresAt: Date.now() + 120_000, provenance: "agent", action: "say" },
        { preambleId: `${mode}-p4`, canvasName: CANVAS, nodeId: "sorrel", text: "all green, ready for review", expiresAt: Date.now() + 120_000, provenance: "agent", action: "state", tone: "green" },
      ]);

      await scene(`${mode} board`, async () => {
        await clearSelection(page);
        await page.waitForTimeout(1_200);
        await expect(page.getByTestId("node-preamble").first()).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: join(SHOTS, `${mode}-board.png`) });
        await node(page, "juniper").screenshot({ path: join(SHOTS, `${mode}-seat-juniper.png`) });
        for (const id of ["maple", "clove", "pip"]) {
          await node(page, id).screenshot({ path: join(SHOTS, `${mode}-seat-${id}.png`) });
        }
      });

      await scene(`${mode} feed`, async () => {
        await clearSelection(page);
        await page.keyboard.press("Meta+I");
        const feed = page.getByTestId("operator-feed");
        await expect(feed).toBeVisible({ timeout: 10_000 });
        await expect(feed.getByTestId("operator-feed-card")).toHaveCount(3, { timeout: 10_000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(SHOTS, `${mode}-feed.png`) });
        await feed.screenshot({ path: join(SHOTS, `${mode}-feed-panel.png`) });
        await page.keyboard.press("Escape");
        await expect(feed).toHaveCount(0);
      });

      await scene(`${mode} multi-prompt`, async () => {
        await clearSelection(page);
        for (const id of ["basil", "clove", "fern", "sorrel"]) {
          await node(page, id).click({ modifiers: ["Shift"] });
        }
        const prompt = page.getByTestId("rts-multi-prompt");
        await expect(prompt).toBeVisible({ timeout: 10_000 });
        await prompt.getByRole("textbox").first().fill("Pull main, rerun the docs build, and tell basil what broke.");
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(SHOTS, `${mode}-multi-prompt.png`) });
        await clearSelection(page);
      });
    }

    await scene("gallery", async () => {
      for (const mode of ["bright", "dark"] as const) {
        await page.evaluate(() => {
          window.location.hash = "#/gallery/marks";
          window.location.reload();
        });
        await expect(page.getByText("Seats and rings")).toBeVisible({ timeout: 30_000 });
        // The gallery follows the saved theme; switch it by the same attribute the app uses.
        await page.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
        await page.waitForTimeout(1_500);
        await page.screenshot({ path: join(SHOTS, `${mode}-gallery.png`), fullPage: true });
      }
    });
  } finally {
    await junto.close();
  }
  expect(failures, failures.join("\n")).toEqual([]);
});
