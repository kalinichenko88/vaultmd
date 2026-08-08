import { describe, expect, test } from 'bun:test';

import { createFenceTracker } from '../fences.ts';

/** Feed every line and collect the lines the tracker says are OUTSIDE a fence. */
function outside(doc: string): string[] {
  const tracker = createFenceTracker();

  return doc.split('\n').filter((line) => !tracker.inFence(line));
}

/** Feed every line and report whether a fence is still open at the end. */
function openAtEnd(doc: string): boolean {
  const tracker = createFenceTracker();
  for (const line of doc.split('\n')) {
    tracker.inFence(line);
  }

  return tracker.isOpen();
}

describe('createFenceTracker', () => {
  test('a balanced backtick block hides its contents', () => {
    expect(outside('a\n```\nb\n```\nc')).toEqual(['a', 'c']);
  });

  test('a tilde marker does not close a backtick fence', () => {
    expect(outside('```ts\n~~~\nhidden\n```\nafter')).toEqual(['after']);
  });

  test('a shorter run does not close a longer opener', () => {
    expect(outside('````\n```\nhidden\n````\nafter')).toEqual(['after']);
  });

  test('a longer run does close a shorter opener', () => {
    expect(outside('```\nhidden\n`````\nafter')).toEqual(['after']);
  });

  test('a tilde fence closes on tildes', () => {
    expect(outside('~~~\nhidden\n~~~\nafter')).toEqual(['after']);
  });

  test('an unclosed fence runs to EOF', () => {
    expect(outside('a\n```\nb\nc')).toEqual(['a']);
  });

  test('0-3 spaces of indent still opens a fence, 4 does not', () => {
    expect(outside('   ```\nhidden\n   ```\nafter')).toEqual(['after']);
    expect(outside('    ```\nplain\n    ```')).toEqual([
      '    ```',
      'plain',
      '    ```',
    ]);
  });

  test('a backtick opener whose info string holds a backtick is not an opener', () => {
    expect(outside('```js `x`\nstill outside')).toEqual([
      '```js `x`',
      'still outside',
    ]);
  });

  test('a closer may carry trailing whitespace but not other text', () => {
    expect(outside('```\nhidden\n```   \nafter')).toEqual(['after']);
    expect(outside('```\nhidden\n``` tail\nstill hidden')).toEqual([]);
  });

  test('CRLF line endings do not break marker matching', () => {
    expect(outside('```\r\nhidden\r\n```\r\nafter\r')).toEqual(['after\r']);
  });

  test('isOpen tracks the final state, which inFence alone cannot express', () => {
    expect(openAtEnd('```\ncode\n```')).toBe(false);
    expect(openAtEnd('```\ncode')).toBe(true);
    // The sequence a loose toggle gets wrong: `~~~` must NOT close, and the
    // final ``` must close the ORIGINAL opener rather than open a new block.
    expect(openAtEnd('```ts\n~~~\n## Fake\n```')).toBe(false);
    expect(openAtEnd('')).toBe(false);
  });
});
