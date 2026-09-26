# Junto brand, open source

![Junto mark](../../assets/brand/junto-icon.png)

The open-source build has no mascot. Its brand is the **Junto mark**: a seat
ring around a seat, twelve amber segments (the activity ring every agent seat
wears) around a solid ink dot. It is drawn from theme tokens in
`src/shared/brand-mark.ts`, so it follows the palette in both modes.

The official build's mascot, Pip, the brand cast, and their surfaces are
private brand content in the overlay repository (see `docs/overlay.md`).

## Surfaces

| Surface | File | Built by |
| --- | --- | --- |
| macOS icon | `build/icon.icns` (light), `build/icon-light.icns`, `build/icon-dark.icns` | `brand-export.ts icon` |
| Linux icon, README | `assets/brand/junto-icon.png` (1024, light) | `brand-export.ts icon` |
| Renderer copy | `src/renderer/assets/brand/junto-icon.png` (256, light) | `brand-export.ts icon` |
| DMG background | `build/dmg-background.png`, `build/dmg-background@2x.png` | `brand-export.ts dmg` |
| Tour guide | the mark beside "a quick tour" | `FirstRunIntro.tsx` |

The icon follows Apple's macOS grid: a 1024 canvas, an 824 squircle body inset
100, and a soft shadow. The DMG is laid out for the 1280 by 720 window and the
icon positions in `package.json` `dmg`; electron-builder pairs the @2x file
into a HiDPI background. An official package takes both from the overlay.

## Export

```bash
bun scripts/brand-export.ts icon    # rewrites build/icon*.icns and junto-icon.png
bun scripts/brand-export.ts dmg     # rewrites build/dmg-background*.png
bun scripts/brand-export.ts one --out seat.png --seed some-seat --expression happy --mode dark --size 1024
```

Wordmark: uppercase JUNTO in `FONT_DISPLAY`, weight 600, letter-spacing
0.14em, theme token `ink`.
