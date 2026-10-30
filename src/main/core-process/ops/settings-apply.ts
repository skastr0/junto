/**
 * What the stored settings mean to this process's runtime, applied in the
 * core where seats are spawned and terminal colours are chosen: the theme
 * preference (with the OS reading main sees and this process cannot) and the
 * operator's tool directories, which a seat's PATH is built from.
 *
 * Main calls it after every settings change and whenever the OS appearance
 * changes. The read is the core's own, so the settings never travel back as
 * an argument and the two copies cannot disagree.
 */
import { Effect, Option } from "effect";
import { SettingsService } from "../../junto/settings/service";
import { setConfiguredToolDirectories } from "../../junto/adapters/exec";
import { setSystemPrefersDark, setThemePreference } from "../../junto/theme-state";
import { coreOps, type CoreOp } from "../ops";

type Asked = { readonly systemPrefersDark?: boolean };

declare module "../ops" {
  interface CoreOps {
    "settings.apply": CoreOp<Asked, void>;
  }
}

coreOps({
  "settings.apply": ({ systemPrefersDark }) =>
    Effect.gen(function* () {
      if (systemPrefersDark !== undefined) setSystemPrefersDark(systemPrefersDark);
      const settings = yield* Effect.serviceOption(SettingsService);
      if (Option.isNone(settings)) return;
      const stored = yield* settings.value.get.pipe(Effect.orElseSucceed(() => undefined));
      if (stored === undefined) return;
      setThemePreference(stored.appearance.theme);
      setConfiguredToolDirectories(stored.advanced.toolDirectories ?? []);
    }),
});
