import { describe, expect, it } from 'vitest';
import { LiveBlockInputError } from '../snapshot';
import { validateBoardInput } from './schema';

describe('validateBoardInput limits', () => {
  it('refuses a 20,000-character card id (35 KB of input that seeded a 101 MB document)', () => {
    const input = {
      columns: [
        {
          id: 'x'.repeat(20_000),
          title: 'Long',
          nodes: Array.from({ length: 5_000 }, () => ({})),
        },
      ],
    };
    const started = Date.now();
    expect(() => validateBoardInput(input)).toThrow(LiveBlockInputError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses ids with characters outside a short id alphabet', () => {
    for (const id of ['has space', 'a/b', '"quoted"', '', 'x'.repeat(65)]) {
      expect(() =>
        validateBoardInput({ columns: [{ id, title: 'A', nodes: [] }] }),
      ).toThrow(LiveBlockInputError);
    }
    expect(() =>
      validateBoardInput({
        columns: [
          {
            id: '0193c7a0-1111-7abc-8def-000000000001',
            title: 'A',
            nodes: [{ id: 'task_1-x', text: 'ok' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a board larger than the size limit', () => {
    const big = 'x'.repeat(9_000);
    const input = {
      columns: [
        {
          id: 'c1',
          title: 'Big',
          nodes: Array.from({ length: 400 }, (_, i) => ({
            id: `t${i}`,
            text: big,
          })),
        },
      ],
    };
    expect(() => validateBoardInput(input)).toThrow(/at most/);
  });
});
