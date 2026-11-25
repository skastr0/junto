/**
 * Does the page see an app switch? Electron's BrowserWindow.blur() stands in
 * for the operator switching to another app: this records what
 * document.hasFocus(), document.visibilityState and the window's own focus
 * say before it, after it and after focus returns (152adbad6 reads the first
 * as "the operator is not looking", so a shown thread is not marked read).
 * On the Linux display with no window manager the blur may change nothing: that
 * is recorded too. Nothing here fails on a value; it fails only when a read
 * cannot be taken.
 *   scripts/run-e2e.sh e2e/scenarios/window-blur-focus.spec.ts
 */
import { canvasReady } from "../harness/canvas";
import { expect, launchJunto, test } from "../harness/launch";

test("what the page sees when its window loses focus", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({});
  const { page } = junto;
  try {
    await canvasReady(page, { timeout: 30_000 });
    const read = async (label: string) => {
      const win = await junto.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; return { focused: w.isFocused(), visible: w.isVisible() }; });
      const doc = await page.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState }));
      return `${label}: window ${JSON.stringify(win)}, document ${JSON.stringify(doc)}`;
    };
    const lines: string[] = [await read("at rest")];
    await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.blur());
    await new Promise((r) => setTimeout(r, 800));
    lines.push(await read("after blur()"));
    await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    await new Promise((r) => setTimeout(r, 800));
    lines.push(await read("after focus()"));
    console.log(`BLUR ${JSON.stringify(lines)}`);
    expect(lines).toHaveLength(3);
  } finally {
    await junto.close();
  }
});
