/**
 * A write in flight when the operator quits is durable: it is there after the
 * restart.
 *
 * The renderer sends the command and main is asked to quit in the same turn,
 * so the reply has not arrived when the quit starts. Main's authoring gate
 * holds the write, the core commits it, the core's close drains its authoring
 * gate before it exits (junto/core.ts:186), and the scope waits for that exit.
 * The relaunched app shows the note on its canvas.
 *   bun run test:e2e:fast e2e/scenarios/quit-write-durable.spec.ts
 */
import { modelFixture } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "quitwrite";
const NOTE = "written-at-quit";

test("a write in flight at quit survives the restart", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([]) } });
  const child = junto.app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    // The write goes out and the quit is asked for before its reply returns.
    await junto.page.evaluate(([canvas, id]) => {
      void window.junto!.modelCommand({
        _tag: "Add",
        canvas: canvas as never,
        nodes: [{ x: 40, y: 40, width: 220, height: 96, z: 0, id: id as never, kind: "note", text: "written at quit" }],
        wires: [],
      });
    }, [CANVAS, NOTE] as const);
    await junto.app.evaluate(({ app }) => {
      app.quit();
    });

    await Promise.race([
      exited,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("the app did not quit within 30s")), 30_000)),
    ]);

    // Same machine state, a new app: the write is there.
    const again = await launchJunto({ sandbox: junto.sandbox });
    try {
      await expect(again.page.getByText("written at quit", { exact: true })).toBeVisible({ timeout: 30_000 });
    } finally {
      await again.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await junto.close().catch(() => undefined);
  }
});
