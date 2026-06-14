/**
 * Epub parsing for RSVP. We only need *raw text* per spine section — the engine
 * just consumes a string. So instead of letting epub.js build a full DOM for
 * every section (a `DOMParser` document + hooks, repeated N times — the slow
 * part on long books), we pull each section's raw XHTML straight from the zip
 * (`archive.getText`) and strip the markup ourselves. Sections are unzipped in
 * parallel. Chapter labels come from the table of contents where they can be
 * matched to a spine href.
 *
 * The text strip is tuned for well-formed XHTML (which epubs are): it drops
 * head/script/style, inserts spaces at block boundaries so words don't fuse,
 * removes remaining tags, and decodes common entities. Plenty for RSVP.
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

  // Unzip all sections concurrently, then extract text in spine order.
  const raws = await Promise.all(spineItems.map((item) => rawSection(book, item)));

  const chapters: Chapter[] = [];
  for (let i = 0; i < spineItems.length; i++) {
    const text = htmlToText(raws[i]);
    if (!text) continue; // skip empty sections (cover, blank pages, etc.)
    const href = String(spineItems[i].href ?? '').split('#')[0];
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

/** Raw XHTML for a spine section, straight from the zip (no DOM build). */
async function rawSection(book: AnyBook, item: AnyBook): Promise<string> {
  // archive.getText expects a zip path with a leading slash; spine items expose
  // the path under a few names depending on how the book was opened.
  for (const candidate of [item.url, item.canonical, item.href]) {
    if (!candidate) continue;
    const url = String(candidate).startsWith('/') ? candidate : `/${candidate}`;
    try {
      const text = await book.archive?.getText(url);
      if (text) return text;
    } catch {
      // try the next candidate path
    }
  }
  return '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', copy: '©', deg: '°',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function fromCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Strip XHTML to readable text, keeping word boundaries intact. */
function htmlToText(html: string): string {
  if (!html) return '';
  const stripped = html
    .replace(/<\?[\s\S]*?\?>/g, ' ') // xml decls / processing instructions
    .replace(/<!--[\s\S]*?-->/g, ' ') // comments
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    // Block-level tags become spaces so adjacent words don't fuse together.
    .replace(/<\/?(?:br|p|div|li|h[1-6]|section|article|tr|td|blockquote|figure|figcaption)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ''); // remaining inline tags: drop without a space
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}
