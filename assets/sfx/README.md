# RTS UI SFX pack

Short static UI sounds for Vellum's RTS attention machine. **Offline pack only**
— never generate at runtime.

## Catalog

| id | file | rising-edge use |
| --- | --- | --- |
| `blocked` | `library/blocked.mp3` | region/edge enters blocked |
| `permission` | `library/permission.mp3` | ACP permission pending |
| `herdr-done` | `library/herdr-done.mp3` | herdr agent done + unseen |
| `booth-review` | `library/booth-review.mp3` | booth pending count rises |
| `orphan` | `library/orphan.mp3` | kernel orphaned arm |
| `cycle` | `library/cycle.mp3` | Space / `` ` `` alert advance (quiet) |

Bundled copy for the renderer: `src/renderer/assets/sfx/*.mp3` (keep in sync).

## Source

Generated once via fal `fal-ai/elevenlabs/sound-effects/v2` (ElevenLabs SFX).
**Suno is not available on fal/flare** — do not wait on it.

Shared voice: dry deep-field UI, mono-feel, ~0.5s, no music, no voice, no long tails.

Prompts live in [`prompts.json`](./prompts.json). Regen:

```sh
# requires FAL_KEY
jq -c '.[]' assets/sfx/prompts.json | while read -r row; do
  id=$(echo "$row" | jq -r .id)
  text=$(echo "$row" | jq -r .text)
  resp=$(curl -sS -X POST 'https://fal.run/fal-ai/elevenlabs/sound-effects/v2' \
    -H "Authorization: Key $FAL_KEY" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$text" '{text:$t, duration_seconds:0.5, prompt_influence:0.65, output_format:"mp3_44100_128"}')")
  url=$(echo "$resp" | jq -r '.audio.url // empty')
  curl -sS -L "$url" -o "assets/sfx/library/${id}.mp3"
  cp "assets/sfx/library/${id}.mp3" "src/renderer/assets/sfx/${id}.mp3"
done
```

Promote only after listening at system volume — reject outliers, re-roll that id.

## Runtime

`src/renderer/lib/sfx.ts` — `playAlert(id)` reads **settings.audio**
(master mute/volume + per-clip enable/volume). Defaults: cycle at 18%, others
~50–55%. Configure under **Settings → Audio**.
