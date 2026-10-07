/**
 * The echo terminal fixture: keys typed into a focused terminal reach the PTY.
 *
 * Holds the harness fixture other specs lean on. An echo terminal runs `tee`,
 * so a line typed into its focus view comes back on screen and lands in a
 * transcript file the spec can read. A spec that needs to prove keyboard
 * input reaches a terminal (under a floating bubble, behind a closed modal)
 * seeds `echoTerminalNode` and waits with `waitForTerminalInput`.
 *
 *   bun run test:e2e:fast e2e/scenarios/terminal-echo-fixture.spec.ts
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canvasDoc, echoTerminalNode } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";
import { waitForTerminalInput } from "../harness/term-ready";

test("a line typed into a focused echo terminal reaches its PTY", async () => {
  const transcript = join(await mkdtemp(join(tmpdir(), "junto-echo-")), "transcript.log");
  const junto = await launchJunto({
    seedCanvases: {
      echo: canvasDoc([
        echoTerminalNode({ id: "term-echo", bindingId: "local:echo-fixture", label: "echo", transcript, x: 80, y: 80 }),
      ]),
    },
  });
  try {
    const { page } = junto;
    const node = page.locator('.react-flow__node[data-id="term-echo"]');
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.locator(".native-terminal-surface__status")).toContainText("control", { timeout: 30_000 });

    // Put the keyboard in the terminal, and prove it is there before typing.
    await surface.locator(".xterm-screen").click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null))
      .toBe(true);

    await page.keyboard.type("hello-pty-42");
    // Nothing is read until the line is entered.
    expect(await readFile(transcript, "utf8").catch(() => "")).not.toContain("hello-pty-42");
    await page.keyboard.press("Enter");
    await waitForTerminalInput(transcript, "hello-pty-42");

    // A second line arrives after the first, in order.
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");
    await waitForTerminalInput(transcript, "second line");
    expect(await readFile(transcript, "utf8")).toMatch(/hello-pty-42\r?\nsecond line\r?\n/);
  } finally {
    await junto.close();
  }
});
