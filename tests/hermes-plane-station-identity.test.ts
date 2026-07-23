import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings, type Settings } from "../src/shared/settings";
import {
  defaultRemoteHostsDocument,
} from "../src/shared/remote-hosts";
import {
  setHostsSnapshot,
} from "../src/main/vellum/hosts/snapshot";
import {
  HermesPlane,
  HermesPlaneLive,
} from "../src/main/vellum/hermes/plane";
import { HermesTransport } from "../src/main/vellum/hermes/transport";
import { SettingsService } from "../src/main/vellum/settings/service";

const PROFILE_TABLE = `
 Profile          Model                        Gateway      Alias
 ───────────────    ───────────────────────────    ───────────    ─────
 ◆default         gpt-5.5                      running      —
`;

const withStation = (
  agentHostId: string,
): Settings => {
  const settings = defaultSettings();
  return {
    ...settings,
    station: {
      ...settings.station,
      role: "remote",
      hostId: "studio",
      agentHostId,
      commandCenterRef: "local",
    },
  };
};

afterEach(() => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
});

describe("HermesPlane station identity hydration", () => {
  it("subscribes before reading so a completed concurrent settings transaction wins", async () => {
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    const loaded = withStation("fleet-old");
    const published = withStation("fleet-new");
    const listeners = new Set<(settings: Settings) => void>();
    const settings = SettingsService.of({
      doctor: Effect.succeed({
        id: "settings",
        label: "settings",
        status: "ok",
        detail: "test",
      }),
      get: Effect.sync(() => {
        for (const listener of listeners) listener(published);
        return loaded;
      }),
      patch: () => Effect.succeed(published),
      setStationTopology: () => Effect.succeed(published),
      reset: () => Effect.succeed(published),
      path: () => "/tmp/vellum-hermes-plane-settings.json",
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const transport = HermesTransport.of({
      profiles: () => Effect.succeed({ ok: true, stdout: PROFILE_TABLE }),
      version: () => Effect.succeed({
        ok: true,
        stdout: "Hermes Agent v0.18.2",
      }),
      identityBatch: () => Effect.succeed({ ok: true, stdout: "" }),
      avatar: () => Effect.succeed({ ok: false, stdout: "" }),
      connectAcp: () => Effect.die("unexpected ACP connection"),
    });
    const dependencies = Layer.merge(
      Layer.succeed(SettingsService, settings),
      Layer.succeed(HermesTransport, transport),
    );
    const layer = Layer.provide(HermesPlaneLive, dependencies);

    const bundle = await Effect.runPromise(
      Effect.gen(function* () {
        const plane = yield* HermesPlane;
        return yield* Effect.promise(() => plane.fetchBundle());
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
      ),
    );

    expect(bundle.entities.map((entity) => entity.key))
      .toEqual(["fleet-new:default"]);
  });
});
