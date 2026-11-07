// Flow's UI can spell this model "Omni Flash 1.2" or "Omni 1.2 Flash".
// Keep selection resilient to that order, but never match the retired 1.1.
export const OMNI_FLASH_12 = "Omni Flash 1.2";
export const OMNI_FLASH_12_DURATIONS = Array.from({ length: 13 }, (_, i) => i + 3);

export function isOmniFlash12(name: string): boolean {
  const tokens: string[] = name.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? [];
  return tokens.includes("omni") && tokens.includes("flash") && tokens.includes("1.2");
}

export function matchesModelLabel(shown: string, requested: string): boolean {
  if (isOmniFlash12(requested)) return isOmniFlash12(shown);
  return shown.toLowerCase().includes(requested.trim().toLowerCase());
}

// Preview only. The classic composer always reads Flow's live credit quote before
// generation; never use this estimate to bypass max_credits.
export function estimateOmniFlash12Credits(duration: number, resolution: "360p" | "720p"): number {
  if (!Number.isInteger(duration) || duration < 3 || duration > 15)
    throw new RangeError("Omni Flash 1.2 supports durations from 3 to 15 seconds");
  const rate = resolution === "360p" ? 1 : 3;
  return rate * Math.min(duration, 10) + 2 * rate * Math.max(0, duration - 10);
}
