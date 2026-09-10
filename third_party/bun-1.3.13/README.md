# Bun 1.3.13 runtime notices and corresponding source

The compiled `vellum-command` control executable contains the stock Bun runtime.
These files travel with that executable in Vellum Command distributions. They
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
in-tree uSockets, uWebSockets, uucode, and zig-clap, plus the pinned WebKit LGPL and
supporting component notices. Some components are platform-specific. Their
presence here does not claim every component is linked on every platform.
The original source retains additional per-file copyright notices. The upstream
index also names polyfills and libraries without an exact source revision;
this directory does not certify an exhaustive inventory of those entries.

## Exact source

The corresponding upstream source and build scripts are publicly available:

| Component | Exact source | Build relationship |
| --- | --- | --- |
| Bun | [Source at the release commit](https://github.com/oven-sh/bun/tree/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79) | Includes the runtime bindings, dependency pins, patches, and build driver. |
| JavaScriptCore / WebKit | [Source at the pinned commit](https://github.com/oven-sh/WebKit/tree/4d5e75ebd84a14edbc7ae264245dcd77fe597c10) | Bun's `scripts/build/deps/webkit.ts` selects this commit. |
| TinyCC | [Source at the pinned commit](https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b) | Bun's `scripts/build/deps/tinycc.ts` selects this commit and applies `patches/tinycc/tcc.h.patch` from the Bun source. |

Every other copied license links to its exact source repository and revision in
the provenance file. GitHub's source archives for those revisions provide the
same sources without requiring Git. Vellum Command's matching source release
contains the control CLI source, dependency lockfile, and
`scripts/build-standalone-cli.ts`; retain it with the binary release's source
revision information.

## Rebuilding with a changed runtime library

JavaScriptCore / WebKit and TinyCC carry LGPL obligations, including the ability
to rebuild with a changed library. Publishing Vellum Command source does not
turn these components into MIT-only dependencies. Retain their full licenses and
the version-specific source and rebuild information with binary distributions.
This document records the available source route; it is not a claim that a local
WebKit rebuild has been executed or that notices alone discharge every source
distribution obligation.

Use the [contribution instructions at this Bun commit](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/project/contributing.mdx)
for the platform's compiler and build prerequisites. The release's current build
scripts, rather than the older `make jsc` example in its license index, define
the build route:

```sh
git clone https://github.com/oven-sh/bun.git bun-source
git -C bun-source checkout bf2e2cecf27e800962b1e7f03d66278f9d5d2e79
git clone https://github.com/oven-sh/WebKit.git bun-source/vendor/WebKit
git -C bun-source/vendor/WebKit checkout 4d5e75ebd84a14edbc7ae264245dcd77fe597c10
cd bun-source
bun install --frozen-lockfile
bun run build:release:local
```

The `release-local` profile builds WebKit from that local source and links Bun
against it. Library changes can be made there before rebuilding. TinyCC's source
selection and patch application are explicit in the versioned build module named
above; retain any corresponding changes when distributing a changed runtime.

From a matching Vellum Command source checkout, invoke its CLI build script with
the resulting Bun executable:

```sh
/path/to/bun-source/build/release-local/bun scripts/build-standalone-cli.ts vellum-command
```

That script invokes `process.execPath` and does not select a cross-compilation
target. In this Bun release, the default native compile path copies the running
Bun executable before attaching the application module graph
([upstream implementation](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/src/StandaloneModuleGraph.zig#L1139)).
This preserves a route to a CLI containing the rebuilt runtime. Official
Vellum Command releases continue to use stock Bun; rebuilding with library
changes is a recipient's independent build.
