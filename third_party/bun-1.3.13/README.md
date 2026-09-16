# Bun 1.3.13 runtime notices

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
every platform.

## Upstream source

The corresponding upstream source and build scripts are publicly available:

| Component | Exact source | Build relationship |
| --- | --- | --- |
| Bun | [Source at the release commit](https://github.com/oven-sh/bun/tree/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79) | Includes the runtime bindings, dependency pins, patches, and build driver. |
| JavaScriptCore / WebKit | [Source at the pinned commit](https://github.com/oven-sh/WebKit/tree/4d5e75ebd84a14edbc7ae264245dcd77fe597c10) | Bun's `scripts/build/deps/webkit.ts` selects this commit. |
| TinyCC | [Source at the pinned commit](https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b) | Bun's `scripts/build/deps/tinycc.ts` selects this commit and applies `patches/tinycc/tcc.h.patch` from the Bun source. |

The npm archive for `peechy@0.4.34` declares MIT but omits a license file, and its
registry Git commit is unavailable upstream. [npm/notice-exceptions.json](npm/notice-exceptions.json)
records that limit. The included official repository MIT text comes from the
last package-manifest change before that package's publication; its association
with the exact npm archive could not be established. No copyright text was
invented or substituted from an unrelated package.

JavaScriptCore / WebKit and TinyCC carry LGPL obligations. Publishing Junto
source does not turn these components into MIT-only dependencies. Retain their
full licenses with binary distributions. Official Junto releases continue to use
stock Bun.

For development from a matching Junto source checkout, compile the control CLI
with the same Bun version recorded in `package.json`:

```sh
bun scripts/build-standalone-cli.ts junto
```
