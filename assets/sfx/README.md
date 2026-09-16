# Junto UI sounds

Three original, offline UI cues. The synthesis source and generated WAV files
are project-owned material distributed under the root Apache-2.0 license.
They contain no recordings, external samples, or model-generated audio.

| Alert | Asset | Duration | Character |
| --- | --- | --- | --- |
| `blocked` | `src/renderer/assets/sfx/blocked.wav` | 240 ms | Low, dry pulse |
| `attention` | `src/renderer/assets/sfx/attention.wav` | 300 ms | Two rising tones |
| `cycle` | `src/renderer/assets/sfx/cycle.wav` | 60 ms | Quiet navigation tick |

The single asset copy lives in the renderer. Rebuild from the repository root:

```sh
bun scripts/build-ui-sfx.ts
bun scripts/build-ui-sfx.ts --check
```

[`build-ui-sfx.ts`](../../scripts/build-ui-sfx.ts) uses integer triangle
oscillators with a short attack and a fading envelope. Output is deterministic
24 kHz mono 16-bit PCM WAV, without metadata or an external encoder. No account,
network connection, API key, or runtime synthesis is required. The focused
`tests/ui-sfx-assets.test.ts` checks byte reproducibility, format, duration,
headroom, and silent boundaries.

[`sfx.ts`](../../src/renderer/lib/sfx.ts) continues to play through Web Audio
(`AudioBufferSourceNode`). The audio feature flag, master mute/volume, per-clip
enable/volume, decode cache, and attention producers retain their behavior.
The `attention` alert uses the durable `permission` settings key. The retired
`orphan` settings key has no sound producer or bundled asset.

## Provenance change

The former pack was generated through fal's ElevenLabs Sound Effects API.
Unrestricted redistribution rights for those raw sound files could not be
established: [ElevenLabs' policy, section 9(c)](https://elevenlabs.io/use-policy)
restricts standalone sound-output distribution, and
[fal's terms, section 14](https://fal.ai/legal/terms-of-service) allow additional
third-party terms. The [fal API terms](https://fal.ai/legal/api-services) do not
establish an exception for open-source asset relicensing.

The replacement cues were composed directly in the synthesis script, without
using the former audio as input. Historical MP3 copies are excluded from the published history.
