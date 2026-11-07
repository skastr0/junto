import { installCosmeticPacks } from "@shared/cosmetics/catalog";
import { decodeCosmeticPacks } from "@shared/cosmetics/load";
import { overlayManifest } from "@shared/overlay";

/**
 * The cosmetic packs this build carries, installed once at module load so
 * the first portrait already sees them. An open-source build bundles none;
 * the official build bundles its premium packs through the overlay. A bad
 * pack is dropped with a log line and never breaks a portrait.
 */
export const bundledCosmeticsRevision = installCosmeticPacks(decodeCosmeticPacks(overlayManifest.cosmetics));
