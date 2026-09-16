# Third-party notices

Project-owned Junto source and artwork are made available under the root
[Apache-2.0 license](LICENSE), to the extent of the project's rights in them.
Third-party components retain their original copyright and license notices.

## Software dependencies

`package.json` and its lockfile identify the
dependencies and versions used by the application and release-serving Worker.
The full license and notice files accompanying those dependencies govern their
redistribution; this index does not replace them.

The desktop runtime includes Electron and its Chromium and Node.js components.
Their distributions contain multiple third-party licenses. Preserve the Electron
license and Chromium notices, as well as the dependency license files included in
the application package. The experimental standalone Remote package also includes
the license supplied with its official Node.js runtime archive.

The compiled control CLI embeds Bun 1.3.13, including statically linked components
with their own licenses. [Version-bound Bun notices](third_party/bun-1.3.13/README.md)
travel with the desktop package. They include the LGPL JavaScriptCore/WebKit and
TinyCC terms; the embedded runtime is not
covered solely by Bun's MIT declaration or this project's Apache license.

Other runtime libraries include React, Effect, XYFlow, xterm.js, Lucide, node-pty,
and electron-updater. Their licenses remain with their installed packages.
External agent harnesses are installed separately and are not relicensed by this
project.

## Artwork and sounds

The brand artwork was directed for this project and generated using image services;
its source brief and generation routes are recorded in
[assets/brand/IDENTITY.md](assets/brand/IDENTITY.md). Generated artwork does not imply
an exclusive right to similar outputs or ownership of the generating models.

The UI sound cues are original, deterministic waveforms generated from
[scripts/build-ui-sfx.ts](scripts/build-ui-sfx.ts). They use no provider audio,
recordings, samples, or model output. Their source and WAV files use Apache-2.0.

Provider services and models used to create artwork are not part of this source
license. Product and third-party names identify their respective projects; the
Apache license does not grant trademark rights.
