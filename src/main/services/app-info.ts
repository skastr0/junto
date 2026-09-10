import { app } from "electron";
import { Context, Effect, Layer } from "effect";
import type { StationInfo } from "@shared/contracts";
import { PRODUCT_NAME } from "@shared/product-name";

/** Installation metadata used by Doctor and Station coordination. */
export class AppInfoService extends Context.Service<AppInfoService,
  {
    readonly stationInfo: Effect.Effect<StationInfo>;
  }>()("@vellum/AppInfoService") {}

export const AppInfoLive = Layer.succeed(
  AppInfoService,
  AppInfoService.of({
    stationInfo: Effect.sync(() => ({
      name: PRODUCT_NAME,
      version: app.getVersion(),
      userDataPath: app.getPath("userData"),
    })),
  }),
);
