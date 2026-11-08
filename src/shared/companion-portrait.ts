/**
 * `portrait.get`: the seat's portrait as the desktop draws it, including any
 * customisation, as one self-contained SVG sized for the phone.
 */

import { portraitDetailFor, portraitSvg, type PortraitConfig } from "./agent-portrait";

export const companionPortraitSvg = (input: {
  readonly portraitIdentity: string;
  readonly size: number;
  readonly theme: "bright" | "dark";
  readonly config?: PortraitConfig;
}): string => {
  const svg = portraitSvg({
    seed: input.portraitIdentity,
    mode: input.theme,
    detail: portraitDetailFor(input.size),
    frame: "tile",
    ...(input.config ? { config: input.config } : {}),
  });
  return svg.replace("<svg ", `<svg width="${input.size}" height="${input.size}" `);
};
