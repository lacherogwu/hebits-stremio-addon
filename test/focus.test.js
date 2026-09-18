import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusPlan, restorePlan, shouldRestore } from '../lib/focus.js';

const q = (index, progress, priority = 1) => ({ index, progress, priority });

test('focus raises the target and never pauses other files', () => {
  const files = [q(0, 1), q(1, 0.3), q(2, 0), q(3, 0.5)];
  assert.deepEqual(focusPlan(files, 2), { raise: [2] });
  assert.deepEqual(focusPlan([q(0, 0.2, 7)], 0), { raise: [] });
  assert.deepEqual(focusPlan([q(0, 1)], 0), { raise: [] });
});

test('restore puts high and top files back to normal either way, paused files only when managed', () => {
  const files = [q(0, 1), q(1, 0.3, 0), q(2, 0.9, 6), q(3, 0.5, 1), q(4, 0.1, 7)];
  assert.deepEqual(restorePlan(files, true), [1, 2, 4], 'a torrent this addon manages: paused files are lifted too');
  assert.deepEqual(restorePlan(files, false), [2, 4], 'a torrent it did not add: the user\'s pause stands');
});

test('restore once the file is done, or after being idle', () => {
  const now = 1_000_000;
  const files = [q(0, 0.5, 7), q(1, 0, 1)];
  assert.equal(shouldRestore({ file: 0, at: now - 1000 }, files, now, 60_000), false);
  assert.equal(shouldRestore({ file: 0, at: now - 61_000 }, files, now, 60_000), true);
  assert.equal(shouldRestore({ file: 0, at: now }, [q(0, 1, 7)], now, 60_000), true);
  assert.equal(shouldRestore({ file: 9, at: now }, files, now, 60_000), true);
});
