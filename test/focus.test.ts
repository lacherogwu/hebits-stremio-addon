import { expect, test } from 'vitest';
import { type FocusFile, focusPlan, restorePlan, shouldRestore } from '../src/focus';

const q = (index: number, progress: number, priority = 1): FocusFile => ({ index, progress, priority });

test('focus raises the target and never pauses other files', () => {
  expect(focusPlan([q(0, 1), q(1, 0.3), q(2, 0), q(3, 0.5)], 2)).toEqual({ raise: [2] });
  expect(focusPlan([q(0, 0.2, 7)], 0)).toEqual({ raise: [] });
  expect(focusPlan([q(0, 1)], 0)).toEqual({ raise: [] });
});

test('restore puts high and top files back to normal either way, paused files only when managed', () => {
  const files = [q(0, 1), q(1, 0.3, 0), q(2, 0.9, 6), q(3, 0.5, 1), q(4, 0.1, 7)];
  expect(restorePlan(files, true)).toEqual([1, 2, 4]);
  expect(restorePlan(files, false)).toEqual([2, 4]);
});

test('restore once the file is done, or after being idle', () => {
  const now = 1_000_000;
  const files = [q(0, 0.5, 7), q(1, 0, 1)];
  expect(shouldRestore({ file: 0, at: now - 1000 }, files, now, 60_000)).toBe(false);
  expect(shouldRestore({ file: 0, at: now - 61_000 }, files, now, 60_000)).toBe(true);
  expect(shouldRestore({ file: 0, at: now }, [q(0, 1, 7)], now, 60_000)).toBe(true);
  expect(shouldRestore({ file: 9, at: now }, files, now, 60_000)).toBe(true);
});

// Units: `nowMs`/`focus.at`/`idleMs` are all epoch-millisecond values (Date.now()),
// the same unit play.ts's focusOn stamps `at` with - never qBittorrent's seconds-based
// timestamps. Pin the millisecond boundary explicitly: 59_999 ms of idle time must not
// yet trigger a restore, but 60_001 ms must.
test('shouldRestore treats idleMs and the at/now gap as milliseconds, not seconds', () => {
  const now = 1_000_000;
  const target = [q(0, 0.5, 7)];
  expect(shouldRestore({ file: 0, at: now - 59_999 }, target, now, 60_000)).toBe(false);
  expect(shouldRestore({ file: 0, at: now - 60_001 }, target, now, 60_000)).toBe(true);
});
