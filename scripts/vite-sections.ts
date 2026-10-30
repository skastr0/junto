import { resolve } from "node:path";
import { externalizeDepsPlugin } from "electron-vite";
import { buildIdentity } from "./build-identity";
import { clearBuildSourceStamp } from "./build-source-stamp";
import { featureViteDefines, resolveBuildFeatures } from "./build-features";
import { machineReleaseCatalogConstant, machineReleaseCatalogForBuild } from "./machine-release-catalog";
import { OVERLAY_PREVIEW_MODE, overlayAlias, overlayDepsPlugin, resolveOverlay } from "./overlay";
import { electronNamespaceImports } from "./electron-namespace-imports";

/**
 * What every section of the Electron build shares: the alias table, the
 * product defines and the overlay. `electron.vite.config.ts` and
 * `electron.core.vite.config.ts` both read it, so the window and the core are
 * compiled by one set of rules.
 */
export type BuildContext = { readonly command: "build" | "serve"; readonly mode: string };

export const buildContext = ({ command, mode }: BuildContext) => {
  // Plus is preview-only until checkout and entitlement delivery are released.
  // Vite's build command/mode, not NODE_ENV or an ambient override, owns intent.
  const preview = command === "serve" || mode === OVERLAY_PREVIEW_MODE;
  const overlay = resolveOverlay(process.env, undefined, preview ? "preview" : "production");

  const alias = {
    "@main": resolve("src/main"),
    "@preload": resolve("src/preload"),
    "@renderer": resolve("src/renderer"),
    "@shared": resolve("src/shared"),
    ...overlayAlias(overlay),
  };

  // Build-time update feed only — never honored as a runtime env override.
  // Empty → macArm64UpdateFeed() uses the interim/public default in compiled-config.
  const updateFeedUrl = (process.env.JUNTO_MAC_UPDATE_FEED_URL ?? "").trim();
  const resolvedBuildFeatures = resolveBuildFeatures(process.env);
  const machineCatalog = machineReleaseCatalogForBuild(process.cwd(), preview);

  const productDefines = {
    __JUNTO_BUILD_ID__: JSON.stringify(buildIdentity(process.cwd())),
    __JUNTO_PREVIEW_BUILD__: JSON.stringify(process.env.JUNTO_PREVIEW_BUILD === "1"),
    __JUNTO_MACHINE_RELEASE_CATALOG__: machineCatalog === undefined ? "undefined" : JSON.stringify(machineReleaseCatalogConstant(machineCatalog)),
    __JUNTO_MAC_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl),
    __JUNTO_MAC_SIGNING_IDENTITY__: JSON.stringify(process.env.JUNTO_MAC_SIGNING_IDENTITY ?? ""),
    __JUNTO_MAC_TEAM_ID__: JSON.stringify(process.env.JUNTO_MAC_TEAM_ID ?? ""),
    // The open-source build folds every premium branch away (docs/overlay.md).
    __JUNTO_PREMIUM__: JSON.stringify(overlay.kind === "official"),
    ...featureViteDefines(resolvedBuildFeatures),
  };

  return { preview, overlay, alias, productDefines };
};

export type MainBuildSection = BuildContext & {
  readonly input: Record<string, string>;
  /** The core's build runs second over the same out/main; it must not clear it. */
  readonly emptyOutDir?: boolean;
  /** Only the window's build stamps out/build-source.json. */
  readonly stampBuild?: boolean;
};

/**
 * The main process's Vite section, shared by the two builds that make
 * `out/main`: the window's entry (`electron.vite.config.ts`) and the core's
 * entry (`electron.core.vite.config.ts`).
 *
 * They used to be two inputs of one Rollup build, and that let a module only
 * the core needs ride a chunk both entries import: main loaded the core's code
 * and ran its module-level singletons as empty copies (seat state, offboard).
 * Two builds each carry their own modules; small stateless code is duplicated
 * into both, which is the point.
 *
 * Every plugin the core needs lives here, `?nodeWorker` support included: the
 * old note in electron.vite.config.ts said a plain `?modulePath` sub-build ran
 * without main's plugins and its worker imports had no default.
 */
export const mainBuildSection = ({ command, mode, input, emptyOutDir, stampBuild = false }: MainBuildSection) => {
  const { overlay, alias, productDefines } = buildContext({ command, mode });
  return {
    plugins: [
      ...(stampBuild ? [clearBuildSourceStamp(process.cwd())] : []),
      externalizeDepsPlugin(),
      overlayDepsPlugin(overlay),
      electronNamespaceImports(),
    ],
    resolve: { alias },
    define: productDefines,
    build: {
      ...(emptyOutDir === undefined ? {} : { emptyOutDir }),
      rollupOptions: { input },
    },
  };
};
