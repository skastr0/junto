/**
 * Launch play e2e: a canvas played before comes back playing.
 *
 * The durable record says paused but played once; the app must read
 * playing, so mail and work reach seats without a press of play per launch.
 */
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { makeStateEngineLive } from "../../src/main/junto/state/engine";
import {
  FactoryPauseRepository,
  FactoryPauseRepositoryLive,
} from "../../src/main/junto/pause/repository";
import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "held";

test.use({
  juntoOptions: {
    offline: true,
    seedCanvases: { [CANVAS]: canvasDoc([]) },
    afterSeed: async (sandbox) => {
      const runtime = ManagedRuntime.make(
        Layer.provide(
          FactoryPauseRepositoryLive,
          makeStateEngineLive(join(sandbox.homeDir, ".junto", "state", "junto.db")),
        ),
      );
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const pause = yield* FactoryPauseRepository;
            yield* pause.setPlaying(CANVAS, true);
            yield* pause.setPlaying(CANVAS, false);
          }),
        );
      } finally {
        await runtime.dispose();
      }
    },
  },
});

test("a canvas played before comes back playing at launch", async ({ junto: { page } }) => {
  await expect
    .poll(async () => page.evaluate(() => Boolean(window.junto?.factoryPauseState)), { timeout: 30_000 })
    .toBe(true);
  const state = await page.evaluate(async (canvas) => window.junto!.factoryPauseState(canvas), CANVAS);
  expect(state).toMatchObject({ playing: true, everPlayed: true });
});
