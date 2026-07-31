# Factory Familiars

Factory Familiars are Vellum Command's optional stock avatar library: twelve tiny
workshop automata with distinct silhouettes and quiet behavioral cues. They are
a deliberate exception to Ether's normal refusal of robot imagery. The
exception stays bounded to agent identity at avatar scale; it does not add
robots to the wider Deep-Field Technical motif library.

## Art direction

**Tactile stop-motion workshop companions.** Each familiar looks like a tiny
living entity assembled beside a treasured 1970s laboratory prototype: painted
cast metal, smoked glass, tiny screws, restrained wear, one signal hue, and a
warm near-black studio field. They are characters first and instruments second.
Pet-like gaze, head tilt, grounded feet, ears, tails, shells, or winglets make
them emotionally legible; personality still appears through posture, mass,
symmetry, wear, and one functional detail—not cartoon mouths, costumes, labels,
or overt archetype symbols.

The portraits share a strict production frame:

- square source, safe for a circular crop;
- subject occupies roughly 72% of the frame;
- creature silhouette, gaze, and paired optical eyes remain legible at Vellum Command's
  20px card size;
- no text, logos, humanoid anatomy, literal animals, glossy plastic, franchise-animation look,
  circuit-board pattern, or steampunk clutter;
- one dominant hue, with at most one tiny calibration signal.

## The cabinet

| Familiar | Public impression | Shape cue | Signal |
| --- | --- | --- | --- |
| Brisk | decisive, quick, forward | leaning wedge + swept vanes | orange |
| Fizz | inventive, surprising, curious | asymmetric orb + spring filament | violet |
| Plumb | patient, balanced, dependable | broad level body + plumb bead | teal |
| Folio | reflective, attentive, archival | layered plates + recessed lens | gold |
| Rivet | persistent, focused, industrious | stout clamp collar + repair rivet | amber |
| Vector | composed, intentional, far-seeing | tall compass plane + bearing whiskers | indigo |
| Gauge | exacting, skeptical, fair | octagonal shell + monocular aperture | cyan |
| Relay | adaptive, connective, sociable | paired shells + bridge filament | rose |
| Ward | vigilant, principled, restrained | arched shelter + protected core | steel-blue |
| Patch | practical, resourceful, upbeat | mismatched panels + repair seam | lime |
| Mote | perceptive, imaginative, uncanny | suspended drop + incomplete ring | violet |
| Still | steady, self-contained, enduring | low vessel + enclosed flywheel | amber |

The names and impressions are library metadata, not labels baked into the
images. A future picker can show names, colors, or no metadata at all.

## Generation

The reproducible source is
[`factory-familiars-v1.spec.json`](./factory-familiars-v1.spec.json). It uses the
Codex provider's `codex.text-to-image.v1` contract with `gpt-5.5`, followed by a
dimension gate for every portrait.

```sh
flare validate assets/agent-avatars/factory-familiars-v1.spec.json
flare plan assets/agent-avatars/factory-familiars-v1.spec.json
flare run assets/agent-avatars/factory-familiars-v1.spec.json --wait --stream
```

Generated binaries are candidates until inspected together at 20px, 36px, and
full size. Promote only a coherent cabinet; regenerate individual outliers from
the same prompt rather than accepting style drift.
