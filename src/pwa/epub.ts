/**
 * Epub parsing for RSVP. We use epub.js only to crack open the container and
 * pull out *raw text* per spine section — we never render it visually (no
 * iframe), since the engine just needs a string. Chapter labels come from the
 * table of contents where they can be matched to a spine href.
 *
 * NOTE: epub.js internals vary across versions and real-world epubs are messy,
 * so this extraction is defensive and may need tuning against actual files.
 */
import ePub from 'epubjs';

export interface Chapter {
  label: string;
  text: string;
  wordCount: number;
}

export interface ParsedBook {
  title: string;
  chapters: Chapter[];
}

// epub.js types are incomplete; treat the book as dynamic and keep our own
// typed surface (ParsedBook) at the boundary.
type AnyBook = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function parseEpub(data: ArrayBuffer): Promise<ParsedBook> {
  const book: AnyBook = (ePub as unknown as (input: ArrayBuffer) => AnyBook)(data);
  await book.ready;

  const title: string = book.packaging?.metadata?.title || 'Untitled';

  // Map spine href -> human label from the TOC (strip #anchors).
  const labels = new Map<string, string>();
  const walk = (items: AnyBook[]): void => {
    for (const it of items ?? []) {
      const href = String(it.href ?? '').split('#')[0];
      const label = String(it.label ?? '').trim();
      if (href && label && !labels.has(href)) labels.set(href, label);
      if (it.subitems?.length) walk(it.subitems);
    }
  };
  walk(book.navigation?.toc ?? []);

  const spineItems: AnyBook[] = book.spine?.spineItems ?? [];
  const chapters: Chapter[] = [];

  for (const item of spineItems) {
    let text = '';
    try {
      await item.load(book.load.bind(book));
      const doc: Document | undefined = item.document;
      text = (doc?.body?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
      item.unload();
    } catch {
      // Unreadable/encrypted section — skip it.
      continue;
    }
    if (!text) continue;

    const href = String(item.href ?? '').split('#')[0];
    const label = labels.get(href) || `Section ${chapters.length + 1}`;
    chapters.push({ label, text, wordCount: countWords(text) });
  }

  try {
    book.destroy?.();
  } catch {
    // ignore
  }

  return { title, chapters };
}

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}
