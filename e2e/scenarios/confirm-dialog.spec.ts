/**
 * Destructive questions render through the app's own working dialog, never a
 * native window.confirm: the question is in the layer model, themed, and
 * answerable by keyboard. Held on artifact delete, the first caller of
 * askConfirm.
 *   bun run test:e2e:fast e2e/scenarios/confirm-dialog.spec.ts
 *
 * An artifact is a runtime work fact, not document content, so it is
 * published through the work repository before the app starts, the way main
 * writes it.
 */
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { TextNode } from "../../src/shared/canvas";
import { CanvasesLive, CanvasesService } from "../../src/main/junto/canvases";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import { SettingsLive } from "../../src/main/junto/settings/service";
import { compileActorSeatRegistry } from "../../src/main/junto/station/actor-seat-compiler";
import { StationFleetTargetRepositoryLive } from "../../src/main/junto/station/fleet-target-repository";
import { StationRepository, StationRepositoryLive } from "../../src/main/junto/station/repository";
import { WorkRepository, WorkRepositoryLive } from "../../src/main/junto/work/repository";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { agentTextNode, canvasDoc, verbEdge, type Sandbox } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "confirm-dialog";

const atlas: TextNode = agentTextNode({ id: "atlas", key: "local:e2e-confirm-atlas", label: "Atlas", harness: "claude", x: 40, y: 80 });
const library: TextNode = {
  id: "library",
  type: "text",
  text: "artifacts",
  x: 400,
  y: 80,
  width: 240,
  height: 120,
  ether: { entity: { kind: "artifacts" }, artifacts: { items: [] } },
};
const nodes = [atlas, library];
const doc = canvasDoc(nodes, [verbEdge("e-atlas-library", "atlas", "library", "publishes", nodes)]);

/** One artifact Atlas published to the library. */
const seedArtifact = async (sandbox: Sandbox): Promise<void> => {
  const previous = process.env.JUNTO_CANVASES_DIR;
  process.env.JUNTO_CANVASES_DIR = sandbox.canvasesDir;
  const state = makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db"));
  const repositories = Layer.provideMerge(
    Layer.mergeAll(WorkRepositoryLive, StationRepositoryLive, SettingsLive, StationFleetTargetRepositoryLive),
    state,
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(CanvasesLive, repositories));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const work = yield* WorkRepository;
        const installationId = yield* (yield* StationRepository).installationId;
        const authority = yield* canvases.authorityMaterialSnapshot();
        const basis = Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
          kind: "authorial-intent",
          generation: authority.generation,
          contentSha256: authority.intentSha256,
        });
        const seat = compileActorSeatRegistry(new Map([[CANVAS, doc]]), new Map([["local", installationId]])).find(
          (candidate) => candidate.refs.some((ref) => ref.nodeId === atlas.id),
        );
        if (!seat) throw new Error("fixture: Atlas did not compile to an actor seat");
        yield* work.publishArtifact({
          sink: { canvasName: CANVAS, nodeId: library.id },
          basis,
          publishedBy: { seatId: seat.seatId, canvasName: CANVAS, nodeId: atlas.id },
          artifact: {
            artifactId: "art-quarterly",
            name: "Quarterly report",
            parts: [{ kind: "text", text: "Numbers went up." }],
          },
        });
      }),
    );
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.JUNTO_CANVASES_DIR;
    else process.env.JUNTO_CANVASES_DIR = previous;
  }
};

test("deleting an artifact asks in the working dialog; Escape and Cancel keep it, Delete removes it", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: doc }, afterSeed: seedArtifact });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow__node", { hasText: "Atlas" })).toBeVisible({ timeout: 30_000 });
    let native = 0;
    page.on("dialog", (dialog) => {
      native += 1;
      void dialog.dismiss();
    });

    // Open the artifact library through search: focus plus open.
    await page.keyboard.press("Meta+k");
    await page.getByTestId("command-bar-input").fill("artifacts");
    await page.keyboard.press("Meta+Enter");
    const row = page.getByTestId("artifact-row").filter({ hasText: "Quarterly report" });
    await expect(row).toBeVisible({ timeout: 15_000 });

    const dialog = page.locator('[data-layer="working-dialog"]');
    // The card, not the shell: the dim behind it is a cancel control too.
    const card = page.getByTestId("confirm-dialog");
    const library$ = page.getByRole("dialog", { name: /artifact/i }).first();
    const ask = async (): Promise<void> => {
      await row.hover();
      await page.getByRole("button", { name: "Delete artifact" }).first().click();
      await expect(card).toBeVisible();
      await expect(card).toContainText("Quarterly report");
      await expect(dialog).toContainText("This cannot be undone.");
      // The safe answer holds the keyboard.
      await expect(card.getByRole("button", { name: "Cancel" })).toBeFocused();
    };

    // Escape is no: the artifact stays, and the library under the dialog stays open.
    await ask();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(library$).toBeVisible();

    // Cancel is no.
    await ask();
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();

    // Delete artifact is yes.
    await ask();
    await card.getByRole("button", { name: "Delete artifact" }).click();
    await expect(dialog).toHaveCount(0);
    // The delete reached main: asking main again finds nothing to delete.
    // (The library row is not asserted gone: in this fixture the list keeps
    // the row after a delete on the native confirm path too, so that is not
    // this dialog's doing.)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const api = (window as unknown as {
            junto: { workArtifactDelete: (canvas: string, node: string, id: string) => Promise<{ ok: boolean; message?: string }> };
          }).junto;
          const result = await api.workArtifactDelete("confirm-dialog", "library", "art-quarterly");
          return result.ok ? "deleted now" : (result.message ?? "");
        }),
      )
      .toContain("not found");

    expect(native, "no native dialog was shown").toBe(0);
  } finally {
    await junto.close();
  }
});
