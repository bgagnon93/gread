/**
 * Audiobookshelf client.
 *
 * The PWA is served same-origin with ABS (https://books.bgagnon.com/gread and
 * .../audiobookshelf), so we use a RELATIVE base path — no CORS, no domain to
 * type in. Only the API key is user-provided (entered once, kept in
 * localStorage). The user picks a book from their "Books" library rather than
 * pasting an item id.
 */

const ABS_BASE = '/audiobookshelf';
const api = (path: string): string => `${ABS_BASE}/api${path}`;

/** Preferred library name; falls back to the first book-type library. */
const PREFERRED_LIBRARY = 'Books';

export interface AbsConfig {
  apiKey: string;
}

export interface AbsBook {
  id: string;
  title: string;
  author: string;
  hasEbook: boolean;
  /** 0–1 reading progress, if any. */
  progress?: number;
  isFinished?: boolean;
  /** epoch ms of last progress update (for ordering Continue Reading). */
  lastUpdate?: number;
}

const ABS_KEY = 'gread:abs';

export function loadAbsConfig(): AbsConfig {
  try {
    const raw = localStorage.getItem(ABS_KEY);
    if (raw) return { apiKey: '', ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { apiKey: '' };
}

export function saveAbsConfig(cfg: AbsConfig): void {
  try {
    localStorage.setItem(ABS_KEY, JSON.stringify(cfg));
  } catch {
    // private mode / quota — non-fatal
  }
}

export function isInProgress(b: AbsBook): boolean {
  const p = b.progress ?? 0;
  return p > 0 && p < 1 && !b.isFinished;
}

/**
 * Fetch the user's books from the "Books" library, with Continue Reading
 * (in-progress) titles first, then the rest alphabetically.
 */
export async function getBooks(cfg: AbsConfig): Promise<{ libraryName: string; books: AbsBook[] }> {
  const libs = await getJson(cfg, '/libraries');
  const libraries: AnyJson[] = libs.libraries ?? [];
  const lib =
    libraries.find((l) => l.name === PREFERRED_LIBRARY) ??
    libraries.find((l) => l.mediaType === 'book') ??
    libraries[0];
  if (!lib) throw new Error('No libraries found on this server.');

  // limit=0 asks ABS for all items (unpaginated).
  const itemsRes = await getJson(cfg, `/libraries/${lib.id}/items?limit=0`);
  const results: AnyJson[] = itemsRes.results ?? itemsRes.libraryItems ?? [];

  // Reading progress, keyed by item id.
  const me = await getJson(cfg, '/me').catch(() => null);
  const progress = new Map<string, AnyJson>();
  for (const p of me?.mediaProgress ?? []) {
    if (p.libraryItemId) progress.set(p.libraryItemId, p);
  }

  let books: AbsBook[] = results.map((it) => {
    const md = it.media?.metadata ?? {};
    const fmt = it.media?.ebookFormat ?? it.media?.ebookFile?.ebookFormat ?? null;
    const p = progress.get(it.id);
    return {
      id: it.id,
      title: md.title ?? md.titleIgnorePrefix ?? 'Untitled',
      author: md.authorName ?? md.authorNameLF ?? '',
      hasEbook: Boolean(fmt),
      progress: p?.progress,
      isFinished: p?.isFinished,
      lastUpdate: p?.lastUpdate,
    };
  });

  // Only filter to ebooks if we could actually detect any — otherwise the
  // field name differs from our guess and we'd hide everything.
  if (books.some((b) => b.hasEbook)) books = books.filter((b) => b.hasEbook);

  books.sort(compareBooks);
  return { libraryName: lib.name ?? 'Library', books };
}

/** Fetch an item's ebook file as raw bytes for epub.js to parse. */
export async function fetchEbook(cfg: AbsConfig, itemId: string): Promise<ArrayBuffer> {
  const res = await request(cfg, api(`/items/${itemId}/ebook`));
  return res.arrayBuffer();
}

// ---- internals ------------------------------------------------------------

type AnyJson = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function compareBooks(a: AbsBook, b: AbsBook): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0); // recent first
  return a.title.localeCompare(b.title);
}

function rank(b: AbsBook): number {
  if (isInProgress(b)) return 0;
  if (b.isFinished) return 2;
  return 1;
}

async function getJson(cfg: AbsConfig, path: string): Promise<AnyJson> {
  const res = await request(cfg, api(path));
  return res.json();
}

async function request(cfg: AbsConfig, url: string): Promise<Response> {
  if (!cfg.apiKey) throw new Error('Enter your Audiobookshelf API key first.');
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  } catch (e) {
    throw new Error(`Could not reach Audiobookshelf (${(e as Error).message}).`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Audiobookshelf rejected the API key (unauthorized).');
  }
  if (!res.ok) {
    throw new Error(`Audiobookshelf returned ${res.status} ${res.statusText}.`);
  }
  return res;
}
