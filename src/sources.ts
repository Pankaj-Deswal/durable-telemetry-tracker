export function sin(unixTimeMs: number): number {
  return Math.sin(unixTimeMs / 10000);
}

export function cos(unixTimeMs: number): number {
  return Math.cos(unixTimeMs / 10000);
}

export const sources = { sin, cos } as const;

export type SourceName = keyof typeof sources;
