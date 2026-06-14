/** Persisted PWA preferences (localStorage). Shared across reading sessions. */

export const THEMES = ['dark', 'light', 'sepia'] as const;
export type Theme = (typeof THEMES)[number];

export interface PwaSettings {
  wpm: number;
  chunkSize: number;
  theme: Theme;
}

const KEY = 'gread:settings';

const DEFAULTS: PwaSettings = { wpm: 300, chunkSize: 1, theme: 'dark' };

export function loadSettings(): PwaSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PwaSettings>;
    return {
      wpm: clampWpm(parsed.wpm ?? DEFAULTS.wpm),
      chunkSize: clampChunk(parsed.chunkSize ?? DEFAULTS.chunkSize),
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULTS.theme,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: PwaSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode / quota — non-fatal; settings just won't persist.
  }
}

function clampWpm(n: number): number {
  return Math.max(60, Math.min(1500, Math.round(n)));
}

function clampChunk(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}
