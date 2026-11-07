/**
 * Main's handlers of the window's companion group (src/contract/window/
 * companion.ts): every core call forwarded as it is, the phone list as a
 * follow stream over the core's notice, and the two answers only main can
 * give, the local port probe and System Settings. The store lives with the
 * core, so main holds no copy of it.
 */
import { shell } from "electron";
import { Effect } from "effect";
import { COMPANION_DEVICES } from "../../contract/core/channels";
import { CompanionCore } from "../../contract/core/companion";
import { CompanionForwarded, CompanionWindowRpcs } from "../../contract/window/companion";
import { probeRemoteLogin } from "../../node/companion/environment";
import { following, forwardTo, fromCore } from "../window/ipc";

/** System Settings, General, Sharing, where Remote Login is switched on. */
export const MAC_REMOTE_LOGIN_SETTINGS_URL = "x-apple.systempreferences:com.apple.Sharing-Settings.extension";

/** A fixed system URL, never one the renderer supplies; false off macOS. */
const openRemoteLoginSettings = async (): Promise<{ readonly ok: boolean }> => {
  if (process.platform !== "darwin") return { ok: false };
  await shell.openExternal(MAC_REMOTE_LOGIN_SETTINGS_URL);
  return { ok: true };
};

export const CompanionWindowHandlers = CompanionWindowRpcs.toLayer(
  Effect.gen(function* () {
    const companion = yield* CompanionCore;
    return {
      ...forwardTo(CompanionForwarded, companion),
      CompanionDevicesFollow: () => following(COMPANION_DEVICES, fromCore(companion.CompanionDevices())),
      CompanionRemoteLogin: () => Effect.promise(() => probeRemoteLogin()),
      CompanionOpenRemoteLoginSettings: () => Effect.promise(openRemoteLoginSettings),
    };
  }),
);
