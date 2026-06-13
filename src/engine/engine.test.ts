import { describe, expect, it, vi } from 'vitest';
import { splitWords } from './tokenize.js';
import { wordMultiplier } from './timing.js';
import { orpIndex } from './orp.js';
import { RsvpEngine, type Scheduler } from './rsvp.js';

describe('splitWords', () => {
  it('splits on whitespace and normalizes runs', () => {
    expect(splitWords('the   quick\tbrown').map((w) => w.text)).toEqual([
      'the',
      'quick',
      'brown',
    ]);
  });

  it('returns empty for blank input', () => {
    expect(splitWords('   \n  ')).toEqual([]);
  });

  it('flags the last word of each paragraph as a block end', () => {
    const words = splitWords('one two\n\nthree four');
    expect(words.map((w) => w.endsBlock)).toEqual([false, true, false, true]);
  });
});

describe('orpIndex', () => {
  it('maps length bands to a pivot near one-third in', () => {
    expect(orpIndex('a')).toBe(0);
    expect(orpIndex('quick')).toBe(1);
    expect(orpIndex('brownish')).toBe(2);
    expect(orpIndex('extraordinary')).toBe(3);
    expect(orpIndex('incomprehensible')).toBe(4);
  });
});

describe('wordMultiplier', () => {
  const w = (text: string, endsBlock = false) => ({ text, endsBlock });

  it('is 1 for an ordinary word', () => {
    expect(wordMultiplier(w('cat'), true)).toBe(1);
  });

  it('lingers on sentence-ending punctuation', () => {
    expect(wordMultiplier(w('end.'), true)).toBeGreaterThan(
      wordMultiplier(w('clause,'), true),
    );
  });

  it('honors the punctuationPause toggle', () => {
    expect(wordMultiplier(w('end.'), false)).toBe(1);
  });

  it('adds dwell time for long words and block ends', () => {
    expect(wordMultiplier(w('antidisestablishment'), true)).toBeGreaterThan(1);
    expect(wordMultiplier({ text: 'x', endsBlock: true }, true)).toBeCloseTo(1.5);
  });

  it('holds longer on longer words (proportional)', () => {
    const short = wordMultiplier(w('reading'), false); // 7 chars -> 1.0
    const mid = wordMultiplier(w('comprehension'), false); // 13 chars
    const long = wordMultiplier(w('incomprehensibility'), false); // 19 chars
    expect(short).toBe(1);
    expect(mid).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(mid);
    expect(mid).toBeCloseTo(1.8, 2); // 1 + 5 * 0.16
  });

  it('caps the raw-length contribution for very long words', () => {
    const huge = wordMultiplier(w('a'.repeat(40)), false);
    expect(huge).toBeCloseTo(3.0, 5); // 1 + capped 2.0, no hyphens
  });

  it('gives compounds extra dwell per internal hyphen/slash', () => {
    const plain = wordMultiplier(w('antidisestablish'), false); // 16 chars, no breaks
    const compound = wordMultiplier(w('twenty-first-cen'), false); // 16 chars, 2 breaks
    expect(compound).toBeCloseTo(plain + 2 * 0.25, 5);
    expect(wordMultiplier(w('and/or'), false)).toBeCloseTo(1.25, 5); // short + 1 break
  });

  it('does not count a trailing dash as an internal break', () => {
    expect(wordMultiplier(w('well-'), false)).toBeCloseTo(1, 5);
  });
});

/** A controllable clock: queue callbacks and fire them on demand. */
function fakeScheduler() {
  const queue: Array<{ cb: () => void; ms: number }> = [];
  const scheduler: Scheduler = {
    set: (cb, ms) => {
      const entry = { cb, ms };
      queue.push(entry);
      return entry;
    },
    clear: (h) => {
      const i = queue.indexOf(h as (typeof queue)[number]);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  return {
    scheduler,
    pending: () => queue.length,
    /** Fire the most recently scheduled callback (LIFO is fine: one at a time). */
    tick: () => {
      const entry = queue.pop();
      entry?.cb();
    },
  };
}

describe('RsvpEngine', () => {
  it('loads text and parks on the first token', () => {
    const e = new RsvpEngine();
    e.load('the quick brown fox');
    const s = e.getState();
    expect(s.total).toBe(4);
    expect(s.index).toBe(0);
    expect(e.getCurrentToken()?.text).toBe('the');
  });

  it('emits a tick on load', () => {
    const e = new RsvpEngine();
    const tick = vi.fn();
    e.on('tick', tick);
    e.load('hello world');
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0][1]?.text).toBe('hello');
  });

  it('advances through tokens when played', () => {
    const clock = fakeScheduler();
    const e = new RsvpEngine({ wpm: 600 }, clock.scheduler);
    e.load('one two three');
    e.play();
    expect(e.getCurrentToken()?.text).toBe('one');
    clock.tick();
    expect(e.getCurrentToken()?.text).toBe('two');
    clock.tick();
    expect(e.getCurrentToken()?.text).toBe('three');
  });

  it('fires end and stops at the last token', () => {
    const clock = fakeScheduler();
    const e = new RsvpEngine({ wpm: 600 }, clock.scheduler);
    const end = vi.fn();
    e.on('end', end);
    e.load('a b');
    e.play();
    clock.tick(); // a -> b
    clock.tick(); // b -> end
    expect(end).toHaveBeenCalledTimes(1);
    expect(e.getState().playing).toBe(false);
  });

  it('pause stops scheduling', () => {
    const clock = fakeScheduler();
    const e = new RsvpEngine({ wpm: 600 }, clock.scheduler);
    e.load('one two three');
    e.play();
    expect(clock.pending()).toBe(1);
    e.pause();
    expect(clock.pending()).toBe(0);
    expect(e.getState().playing).toBe(false);
  });

  it('seek clamps to valid range', () => {
    const e = new RsvpEngine();
    e.load('one two three');
    e.seek(99);
    expect(e.getState().index).toBe(2);
    e.seek(-5);
    expect(e.getState().index).toBe(0);
  });

  it('replaying from the last token restarts at the top', () => {
    const e = new RsvpEngine();
    e.load('one two three');
    e.seek(2);
    e.play();
    expect(e.getState().index).toBe(0);
  });

  it('chunkSize groups words and preserves reading position', () => {
    const e = new RsvpEngine();
    e.load('one two three four five six');
    expect(e.getState().total).toBe(6);
    e.seek(4); // word "five"
    e.setChunkSize(2);
    const s = e.getState();
    expect(s.total).toBe(3);
    expect(e.getCurrentToken()?.text).toBe('five six');
    expect(s.index).toBe(2);
  });

  it('clamps wpm to sane bounds', () => {
    const e = new RsvpEngine();
    e.setWpm(99999);
    expect(e.getState().wpm).toBe(1500);
    e.setWpm(1);
    expect(e.getState().wpm).toBe(60);
  });
});
