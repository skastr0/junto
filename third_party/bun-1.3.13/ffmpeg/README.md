# Electron 43.2.0 FFmpeg source/rebuild evidence

This is a source-backed recipient recipe, not an executed FFmpeg/Electron rebuild.

Exact chain: Electron `9b58e96340a34cccaccc08e410e76838b50b0cb2` (`v43.2.0`) DEPS selects Chromium `150.0.7871.129`, commit `e69b30bba288603e514cffb4c79c359cac68e923`; Chromium DEPS selects FFmpeg `ad41607c61898cf7150e0fb20fe4bbabd44922a3`. Electron applies only `patches/ffmpeg/link_with_loader_path.patch` from its `.patches` list.

Archive layout:

- Electron codeload archive has one wrapper directory; its contents belong at `src/electron` in the upstream checkout.
- FFmpeg archive is rootless; its contents belong at `src/third_party/ffmpeg`.
- Chromium build archive is rootless; contents belong at `src/build`.
- Chromium Opus archive is rootless; contents belong at `src/third_party/opus` (includes `src/include/opus.h`, library implementation and COPYING).
- Chromium media/ffmpeg archive is rootless; contents belong at `src/media/ffmpeg`.
- NASM archive is rootless; contents belong at `src/third_party/nasm`. It supplies Chromium's GN assembly integration for x86 builds as well as assembler source; macOS arm64 does not take that assembly dependency.

The FFmpeg archive retains `BUILD.gn`, `ffmpeg_generated.gni`, `ffmpeg_options.gni`, `chromium/config/Chrome/{mac,linux}/...`, upstream source and licenses. Its mac/arm64 config has `CONFIG_GPL=0`, `CONFIG_NONFREE=0`, `CONFIG_VERSION3=0`, `CONFIG_LIBOPUS=1`. `BUILD.gn:246-248` explains the Opus source archive.

Use the manual GN checkout/build procedure in the provided Electron source `docs/development/build-instructions-gn.md`, with platform prerequisites in `docs/development/build-instructions-macos.md` or its Linux equivalent. Select the exact Electron commit above before synchronizing DEPS; do not build moving `main`. Standard `gclient` synchronization obtains the remaining Chromium build checkout/toolchain material and applies Electron patches. This source set is not an offline mirror of the entire Chromium browser build graph.

After a synchronized, matching checkout exists, edit the desired FFmpeg source in `src/third_party/ffmpeg`. Source archives can restore these exact subtrees in that layout. A raw FFmpeg archive is before Electron's patch: if replacing a patched checkout, apply its one patch exactly once (or let the normal Electron patch hook do so), and do not silently discard it.

From the checkout's `src` directory, the upstream release profile and library target are:

```sh
gn gen out/Release --args='import("//electron/build/args/release.gn")'
ninja -C out/Release ffmpeg
```

The release profile sets `is_component_ffmpeg=true`; `all.gn` selects Chrome codec configuration. Building `electron` instead of `ffmpeg` is the documented complete-runtime target when a recipient also wants a rebuilt Electron application. Toolchain, SDK and profile-data prerequisites follow the pinned upstream build instructions. No private Junto signing account or remote-execution service is required; use the manual local build route.

For macOS arm64, the modified shared library is `out/Release/libffmpeg.dylib`. The stock installed Electron43.2.0 library was independently read with `otool -L`: its identity is `@loader_path/libffmpeg.dylib` and its only dynamic dependency is system `libSystem.B.dylib`. In an independent local Junto package the replacement location is `Junto.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`; Linux uses the bundled `libffmpeg.so` next to the Electron executable. Preserve architecture and ABI. Repackage with the documented unsigned source-build lane or the recipient's own signing identity; altering an official signed app does not preserve its signature/notarization. These locations and build targets are grounded in source/binary inspection, not a claim that a modified-library launch was executed.

Primary version-bound files:

- https://github.com/electron/electron/blob/9b58e96340a34cccaccc08e410e76838b50b0cb2/DEPS
- https://github.com/electron/electron/blob/9b58e96340a34cccaccc08e410e76838b50b0cb2/build/args/release.gn
- https://github.com/electron/electron/blob/9b58e96340a34cccaccc08e410e76838b50b0cb2/docs/development/build-instructions-gn.md
- https://github.com/electron/electron/blob/9b58e96340a34cccaccc08e410e76838b50b0cb2/patches/ffmpeg/link_with_loader_path.patch
- https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/ad41607c61898cf7150e0fb20fe4bbabd44922a3/README.chromium
