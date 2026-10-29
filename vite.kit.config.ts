import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import postcss, { type Rule } from "postcss";
import { defineConfig, type Plugin } from "vite";
import { featureViteDefines, resolveBuildFeatures } from "./scripts/build-features";
import { overlayAlias, resolveOverlay } from "./scripts/overlay";

// The kit build (bun run kit:build): src/renderer/kit as an ES library for
// the website and docs. React stays the host's; everything else is bundled.
// Always the open-source overlay and the ship feature set: the site shows
// what a downloaded app shows.

/** The document root with its attributes: html[data-theme=bright], :root[data-surface-motion=paused]. */
const ROOT_WITH_ATTRIBUTES = /^(?:html|:root)((?:\[[^\]]+\])+)/;

/**
 * One selector's shadow-root twin, or none when it does not hang off the
 * document root. The root's attributes (theme, motion gate, platform) move
 * onto the host: the page sets them on the element the kit is mounted in.
 */
const hostTwin = (selector: string): string | undefined => {
  const trimmed = selector.trim();
  const attributes = ROOT_WITH_ATTRIBUTES.exec(trimmed);
  if (attributes) return `:host(${attributes[1]!})${trimmed.slice(attributes[0].length)}`;
  if (/^:root(?![\w-])/.test(trimmed)) return `:host${trimmed.slice(":root".length)}`;
  return undefined;
};

/** Every rule on :root or the bright theme also applies to a shadow root's host. */
const shadowRootSheet = (): Plugin => ({
  name: "junto-kit-shadow-root",
  apply: "build",
  // On disk, once written: vite emits a library's CSS after generateBundle.
  writeBundle(options, bundle) {
    for (const fileName of Object.keys(bundle)) {
      if (!fileName.endsWith(".css")) continue;
      const path = join(options.dir ?? "dist/kit", fileName);
      const root = postcss.parse(readFileSync(path, "utf8"));
      root.walkRules((rule: Rule) => {
        const twins = rule.selectors.map(hostTwin).filter((twin): twin is string => twin !== undefined);
        const fresh = twins.filter((twin) => !rule.selectors.includes(twin));
        if (fresh.length > 0) rule.selectors = [...rule.selectors, ...fresh];
      });
      writeFileSync(path, root.toString());
    }
  },
});

export default defineConfig(() => {
  const features = resolveBuildFeatures({ JUNTO_FEATURE_PROFILE: "ship" });
  return {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
        ...overlayAlias(resolveOverlay({})),
      },
    },
    define: {
      __JUNTO_PREMIUM__: "false",
      ...featureViteDefines(features),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [react(), tailwindcss(), shadowRootSheet()],
    build: {
      outDir: "dist/kit",
      emptyOutDir: true,
      cssCodeSplit: false,
      sourcemap: true,
      lib: {
        // learn: the lessons' schema alone, for hosts that cannot load React.
        entry: { index: resolve("src/renderer/kit/index.ts"), learn: resolve("src/renderer/kit/learn.ts") },
        formats: ["es"],
        fileName: (_format, name) => `${name}.js`,
        cssFileName: "kit",
      },
      rollupOptions: {
        external: [/^react($|\/)/, /^react-dom($|\/)/],
      },
    },
  };
});
