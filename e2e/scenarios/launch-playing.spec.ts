/**
 * Launch pause e2e: a canvas left playing comes back paused.
 *
 * A playing canvas restored at launch would wake agent seats before the
 * operator did anything, and macOS names Junto on whatever those agents
 * read. The durable record says playing; the app must read paused, keep the
 * first-play latch, and write the pause back.
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
          }),
        );
      } finally {
        await runtime.dispose();
      }
    },
  },
});

test("a canvas left playing comes back paused at launch", async ({ junto: { page } }) => {
  await expect
    .poll(async () => page.evaluate(() => Boolean(window.junto?.factoryPauseState)), { timeout: 30_000 })
    .toBe(true);
  const state = await page.evaluate(async (canvas) => window.junto!.factoryPauseState(canvas), CANVAS);
  expect(state).toMatchObject({ playing: false, everPlayed: true });
});
