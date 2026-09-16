# Bun 1.3.13 runtime notices and corresponding source

The compiled `junto` control executable contains the stock Bun runtime.
These files travel with that executable in Junto distributions. They
retain upstream license text; Apache-2.0 does not replace these component licenses.

The runtime is Bun **1.3.13**, source commit
`bf2e2cecf27e800962b1e7f03d66278f9d5d2e79`. The official macOS archive contains the
runtime binary alone. Bun's `--licenses` argument does not print runtime notices;
`bun pm licenses` inventories application packages, not the statically linked
runtime. Those mechanisms do not replace this directory.

## Notice provenance

[provenance.json](provenance.json) records each copied file's exact upstream URL,
revision, byte count, and SHA-256. Bodies are unchanged. The picohttpparser entry
retains the leading copyright and complete license comment from its header,
without copying the implementation.

[Bun's own license declaration](bun/LICENSE.md) identifies Bun as MIT and describes
its linked libraries. That upstream file is an index, not a complete collection
of their license texts. It contains no separate Bun runtime copyright line or
full MIT license body. We preserve that declaration as supplied and do not
substitute the Microsoft copyright from Bun's separately licensed type package.
The component MIT files here preserve their actual upstream copyright notices
and complete terms.

This collection includes the licenses from Bun's pinned native build dependencies,
in-tree uSockets, uWebSockets, uucode, and zig-clap, plus the pinned WebKit LGPL,
ICU, Zig, Rust, and embedded npm component notices. The Rust and npm directories
have separate per-archive provenance receipts. Some components are
platform-specific; their presence does not claim every component is linked on
every platform. Complete source archives retain the additional per-file notices.

## Exact source

The corresponding upstream source and build scripts are publicly available:

| Component | Exact source | Build relationship |
| --- | --- | --- |
| Bun | [Source at the release commit](https://github.com/oven-sh/bun/tree/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79) | Includes the runtime bindings, dependency pins, patches, and build driver. |
| JavaScriptCore / WebKit | [Source at the pinned commit](https://github.com/oven-sh/WebKit/tree/4d5e75ebd84a14edbc7ae264245dcd77fe597c10) | Bun's `scripts/build/deps/webkit.ts` selects this commit. |
| TinyCC | [Source at the pinned commit](https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b) | Bun's `scripts/build/deps/tinycc.ts` selects this commit and applies `patches/tinycc/tcc.h.patch` from the Bun source. |

[runtime-source-catalog.json](runtime-source-catalog.json) pins the exact source
archive bytes, SHA-256, origin, and revision selected by this release. It includes
all external native source roots, Node 24.3.0 interface headers, the Zig source
containing its bundled standard library, the 43 registry archives in lol-html's
`c-api/Cargo.lock`, and the 121 locked npm package archives selected by Bun's
embedded fallback/error-page/code-generation inputs. A Rust or npm entry's
`revision` identifies the parent source lockfile; its filename, registry URL and
digest select the package version. Registry archives retain their original
gzip-tar bytes under a `.tar.gz` filename.

WebKit's GitHub archive endpoint does not provide this revision's source tarball.
Its catalog entry therefore specifies a shallow fetch of the exact public Git
commit, followed by `git archive` with the recorded prefix and Bun 1.3.13's gzip
implementation at compression level 9. The preparer requires that exact Bun
version when creating this archive; a different gzip implementation can produce
different compressed bytes. The archive includes the complete Git tree, without Git history, local
files, or build output. Bun's archive contains its build driver and patches;
WebKit's contains the JavaScriptCore build scripts and platform configuration.
Gitiles generates request-time timestamps inside its source tarballs. Entries
marked `normalized-tar` are repacked with the pinned `tar` dependency and Bun
1.3.13 gzip implementation, removing timestamps and owner metadata while retaining
file bytes, paths, executable modes, and symlink targets. Their catalog checksums
identify those reproducible archives. The five affected source trees were checked
against the immutable upstream Git trees when these digests were established.

No runtime source archive is committed to the Junto repository.

Release preparation downloads these materials into a separate local directory:

```sh
bun scripts/prepare-runtime-sources.ts --directory /path/to/runtime-sources --cache-dir /path/to/source-cache
```

The preparer verifies the catalog, rejects unexpected directory entries and
symlinks, and writes `runtime-sources.json`. A changed or incomplete archive is a
failure. Release preparation then combines that index with the exact
Junto source commit, the bundled CLI JavaScript payload, its input receipt,
notices, and `RELINK.md`. The publisher requires the source files and uploads
them beside the versioned binary downloads before making a feed available. This
is actual same-place source download access, rather than a future written offer.
The source download index also carries the Electron FFmpeg source/build material
described in [ffmpeg/README.md](ffmpeg/README.md). `electronVersion` and
`bunVersion` bind both runtime versions. Source archives larger than the upload
transport limit are downloaded as ordered, checksum-bound parts; the release's
`RELINK.md` explains reconstruction of the original archive before extraction.

The npm archive for `peechy@0.4.34` declares MIT but omits a license file, and its
registry Git commit is unavailable upstream. [npm/notice-exceptions.json](npm/notice-exceptions.json)
records that limit. The included official repository MIT text comes from the
last package-manifest change before that package's publication; its association
with the exact npm archive could not be established. No copyright text was
invented or substituted from an unrelated package.

## Rebuilding with a changed runtime library

JavaScriptCore / WebKit and TinyCC carry LGPL obligations, including the ability
to rebuild with a changed library. Publishing Junto source does not
turn these components into MIT-only dependencies. Retain their full licenses and
the version-specific source and rebuild information with binary distributions.
The procedure below records the native rebuild route. A full local WebKit or
FFmpeg rebuild has not been executed as part of release preparation. Source
preparation verifies the supplied files, and Cargo's offline dependency
resolution has been checked against the supplied Rust archives.

Use the [contribution instructions at this Bun commit](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/project/contributing.mdx)
for the platform's compiler and build prerequisites. The release's current build
scripts, rather than the older `make jsc` example in its license index, define
the build route:

```sh
mkdir bun-source
tar -xzf /path/to/runtime-sources/bun-bf2e2cecf27e800962b1e7f03d66278f9d5d2e79.tar.gz --strip-components=1 -C bun-source
mkdir -p bun-source/vendor/WebKit
tar -xzf /path/to/runtime-sources/webkit-4d5e75ebd84a14edbc7ae264245dcd77fe597c10.tar.gz --strip-components=1 -C bun-source/vendor/WebKit
cd bun-source
bun install --frozen-lockfile
bun run build:release:local
```

The `release-local` profile builds WebKit from that local source and links Bun
against it. Library changes can be made there before rebuilding. TinyCC's source
selection and patch application are explicit in the versioned build module named
above; retain any corresponding changes when distributing a changed runtime.
The native dependency fetcher (`scripts/build/fetch-cli.ts`) supports cached
source archives and preserves edits when the source identity stamp matches.
Each GitHub archive cache filename is
`<dependency-name>-<first-16-hex-of-SHA256(https://github.com/<repository>/archive/<source-ref>.tar.gz)>.tar.gz`.
Use the dependency's exact `name` and source ref from `scripts/build/deps/` when
seeding the configured cache's `tarballs/` directory; Brotli's source ref is
`v1.1.0`, whose resolved commit is recorded in the catalog. This lets the native
build driver apply its original patches and write the correct source stamp.

For registry inputs, npm provenance records the exact source lockfile and package
key for every tarball, including nested dependency locations. The supplied
archives can restore those `node_modules` packages without fetching their source
again. Ordinary build tools and their prerequisites remain described in Bun's
versioned contribution instructions; this source set is not a mirror of an
entire operating system or compiler installation.

Stock Linux Bun's prebuilt WebKit contains static ICU 75.1. Its exact ICU source
archive and notices are included, and WebKit's `Dockerfile` records that build.
macOS uses system ICU. The POSIX `release-local` build uses system ICU (Linux
development packages; macOS headers and system libraries), so this route is not
a claim of byte-identical reproduction of the stock Linux executable.

To restore lol-html's Cargo registry inputs from the source downloads, run:

```sh
python3 /path/to/Junto-source/third_party/bun-1.3.13/restore-cargo-sources.py /path/to/runtime-sources /path/to/new-cargo-source-directory
cargo metadata --offline --locked --format-version 1 --config /path/to/new-cargo-source-directory/cargo-source-config.toml --manifest-path /path/to/bun-source/vendor/lolhtml/c-api/Cargo.toml
```

The helper uses Python 3.9 or later and creates a new directory containing the
43 unchanged crate source trees, file checksums, package checksums, and a Cargo
directory-source configuration. It does not modify global Cargo configuration.
Apply that configuration to the native Cargo build through its `--config` option
or the local source checkout's `.cargo/config.toml`. The matching lol-html
archive supplies its root and `c-api` manifests and lockfile.

The source download's `RELINK.md` provides the primary final linking step:
compile the supplied `Junto-<version>-cli.js` payload with the rebuilt
Bun executable. That payload includes the application code and its bundled
JavaScript dependencies, with a hash-bound receipt and notices, and does not
require regenerating it from a package registry.

For development from the matching Junto source checkout, the CLI build
script can also be invoked with the resulting Bun executable:

```sh
/path/to/bun-source/build/release-local/bun scripts/build-standalone-cli.ts junto
```

That script invokes `process.execPath` and does not select a cross-compilation
target. In this Bun release, the default native compile path copies the running
Bun executable before attaching the application module graph
([upstream implementation](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/src/StandaloneModuleGraph.zig#L1139)).
This preserves a route to a CLI containing the rebuilt runtime. Official
Junto releases continue to use stock Bun; rebuilding with library
changes is a recipient's independent build.
