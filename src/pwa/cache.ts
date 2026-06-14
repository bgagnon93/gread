/**
 * IndexedDB cache of parsed books, keyed by Audiobookshelf item id.
 *
 * We store only the *extracted text* (chapters), never the source epub — for a
 * 170 MB image-heavy book that's a few MB of text vs. the whole file. The first
 * open still pays the download; every later open on this device is instant.
 *
 * Cache is per-device. Cross-device first-opens still download (a Range-request
 * partial fetch would be the way to avoid that, but it's a separate effort).
 */
import type { Chapter } from './epub.js';

const DB_NAME = 'gread';
const STORE = 'books';
const VERSION = 1;

export interface CachedBook {
  itemId: string;
  title: string;
  chapters: Chapter[];
  cachedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'itemId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedBook(itemId: string): Promise<CachedBook | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(itemId);
      req.onsuccess = () => resolve((req.result as CachedBook) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // no IndexedDB (private mode, etc.) — just skip the cache
  }
}

export async function putCachedBook(book: CachedBook): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(book);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // non-fatal: failing to cache just means the next open re-downloads
  }
}
