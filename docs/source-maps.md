# Source maps

A renderer error in `~/.junto/logs/app.jsonl` names a bundle line, such as
`(junto-app://renderer/assets/index-FcIFvAbn.js:17415)`. The shipped bundles are
not minified, but their line numbers mean nothing without the build. Every
release keeps the source maps of every program, outside the app, so that line
maps back to source.

## What is kept

- The build writes **hidden** source maps for the window bundle, the preload,
  main, the core process, the terminal process and the overseer host (`releaseSourceMaps`
  in `scripts/vite-sections.ts`). A hidden map is a `.map` file beside the
  bundle; the bundle has no `sourceMappingURL` comment.
- Packaging leaves every `.map` out of the app, ours and the ones third-party packages ship (`"!**/*.map"` in the
  `files` lists of `package.json`), and the package audit fails the package if
  one slips in, or if a shipped script points at a map (`auditNoSourceMaps`
  in `scripts/audit-packaged-app.ts`).
- The package scripts run `scripts/collect-sourcemaps.ts` before they publish, so
  one archive, `junto-sourcemaps-<version>-<commit12>.tar.gz`, is published
  beside the app, the zip and the dmg in the release directory. It holds every map and a
  `manifest.json` (version, commit, and each map with the bundle it maps and
  both hashes). It refuses a build in which a program has no map, and never replaces an
  archive that exists. A perf build (`JUNTO_PERF_BUILD=1`) keeps visible maps for the window.

## Mapping a logged line

```text
bun scripts/sourcemap-resolve.ts junto-sourcemaps-0.11.16-0123456789ab.tar.gz \
  'junto-app://renderer/assets/index-FcIFvAbn.js:17415'
```

The location is what the log prints: the renderer URL, a path inside the build
(`out/main/core-process.js:2140:17`) or a bundle name. The renderer's log gives a
line and no column, so the output lists every original position that line holds;
with a column, it names the one segment. It prints the original file, line and
column, and the source line when the map carries it. Take the archive of the
release the log came from: the manifest names the version and commit, and the
bundle hashes there tell whether a bundle is the one that was released.

If the archive is missing, a release is rebuilt from its tag on a VM with
`JUNTO_FEATURE_PROFILE=ship bun run build:bundles`, then
`bun scripts/collect-sourcemaps.ts --out <dir>`. 0.11.15 rebuilt this way is
byte for byte the shipped window bundle; main and the core process differ only
in the signing identity and the build-identity comment the release appends.
