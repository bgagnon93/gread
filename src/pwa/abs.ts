/**
 * Minimal Audiobookshelf client. Milestone 2 first cut: fetch an item's epub
 * by id using the confirmed `GET /api/items/{id}/ebook` endpoint, authenticated
 * with an API key. Library browsing comes later once the list-API response
 * shapes are confirmed against a live server.
 */

export interface AbsConfig {
  /** Base URL up to (but not including) /api, e.g. https://books.example.com/audiobookshelf */
  baseUrl: string;
  apiKey: string;
}

const ABS_KEY = 'gread:abs';

export function loadAbsConfig(): AbsConfig {
  try {
    const raw = localStorage.getItem(ABS_KEY);
    if (raw) return { baseUrl: '', apiKey: '', ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { baseUrl: '', apiKey: '' };
}

export function saveAbsConfig(cfg: AbsConfig): void {
  try {
    localStorage.setItem(ABS_KEY, JSON.stringify(cfg));
  } catch {
    // private mode / quota — non-fatal
  }
}

/** Accept a full ABS item URL or a bare UUID and extract the item id. */
export function parseItemId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const fromUrl = s.match(/items\/([0-9a-fA-F-]{36})/);
  if (fromUrl) return fromUrl[1];
  if (/^[0-9a-fA-F-]{36}$/.test(s)) return s;
  return null;
}

/** Fetch an item's ebook file as raw bytes for epub.js to parse. */
export async function fetchEbook(cfg: AbsConfig, itemId: string): Promise<ArrayBuffer> {
  if (!cfg.baseUrl) throw new Error('Set your Audiobookshelf server URL first.');
  if (!cfg.apiKey) throw new Error('Set your Audiobookshelf API key first.');
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/items/${itemId}/ebook`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  } catch (e) {
    // Network/CORS failures surface here with an opaque message.
    throw new Error(
      `Could not reach Audiobookshelf (${(e as Error).message}). ` +
        `If gread isn't served from the same origin as ABS, this is likely CORS.`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Audiobookshelf rejected the API key (unauthorized).');
  }
  if (!res.ok) {
    throw new Error(`Audiobookshelf returned ${res.status} ${res.statusText}.`);
  }
  return res.arrayBuffer();
}
