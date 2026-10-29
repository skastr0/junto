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

const BRIGHT = /^html\[data-theme=(["']?)bright\1\]/;

/** One selector's shadow-root twin, or none when it does not hang off the document root. */
const hostTwin = (selector: string): string | undefined => {
  const trimmed = selector.trim();
  if (trimmed.startsWith(":root")) return `:host${trimmed.slice(":root".length)}`;
  if (BRIGHT.test(trimmed)) return trimmed.replace(BRIGHT, ':host([data-theme="bright"])');
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
        entry: resolve("src/renderer/kit/index.ts"),
        formats: ["es"],
        fileName: () => "index.js",
        cssFileName: "kit",
      },
      rollupOptions: {
        external: [/^react($|\/)/, /^react-dom($|\/)/],
      },
    },
  };
});
