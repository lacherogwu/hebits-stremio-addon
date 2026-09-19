import { expect, test } from 'vitest';
import { CoverCache } from '../src/covers';

test('returns a remembered cover', () => {
  const covers = new CoverCache();
  covers.remember('1', 'https://example.com/1.jpg');
  expect(covers.get('1')).toBe('https://example.com/1.jpg');
});

test('returns undefined for an unknown id', () => {
  const covers = new CoverCache();
  covers.remember('1', 'https://example.com/1.jpg');
  expect(covers.get('missing')).toBeUndefined();
});

test('remember with an undefined cover stores nothing', () => {
  const covers = new CoverCache(2);
  covers.remember('a', 'A');
  covers.remember('b', 'B');
  covers.remember('c', undefined);
  expect(covers.get('c')).toBeUndefined();
  // An undefined cover must not consume a cache slot: 'a' would be the eviction
  // victim if remembering 'c' had actually inserted an entry.
  expect(covers.get('a')).toBe('A');
});

test('never exceeds its cap', () => {
  const covers = new CoverCache(3);
  covers.remember('a', 'A');
  covers.remember('b', 'B');
  covers.remember('c', 'C');
  covers.remember('d', 'D');
  covers.remember('e', 'E');
  const remembered = ['a', 'b', 'c', 'd', 'e'].filter((id) => covers.get(id) !== undefined);
  expect(remembered).toHaveLength(3);
});

test('evicts oldest-first, keeping the newest', () => {
  const covers = new CoverCache(2);
  covers.remember('a', 'A');
  covers.remember('b', 'B');
  covers.remember('c', 'C');
  expect(covers.get('a')).toBeUndefined();
  expect(covers.get('b')).toBe('B');
  expect(covers.get('c')).toBe('C');
});
