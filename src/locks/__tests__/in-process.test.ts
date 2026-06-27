import { describe, expect, test } from 'bun:test';

import { withFileLock } from '../in-process.ts';

describe('withFileLock', () => {
  test('serializes concurrent fns sharing a key', async () => {
    const order: string[] = [];

    const slow = withFileLock('k', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');

      return 'a';
    });
    const fast = withFileLock('k', async () => {
      order.push('b-start');
      order.push('b-end');

      return 'b';
    });

    const [ra, rb] = await Promise.all([slow, fast]);
    expect(ra).toBe('a');
    expect(rb).toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('different keys run concurrently', async () => {
    const order: string[] = [];

    const p1 = withFileLock('k1', async () => {
      order.push('1-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('1-end');
    });
    const p2 = withFileLock('k2', async () => {
      order.push('2-start');
      order.push('2-end');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['1-start', '2-start', '2-end', '1-end']);
  });

  test('a rejecting fn still releases the lock for the next holder', async () => {
    await expect(
      withFileLock('z', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // next acquirer must not deadlock behind the failed one
    expect(await withFileLock('z', async () => 'ok')).toBe('ok');
  });
});
