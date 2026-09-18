import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthTracker } from '../lib/health.js';

function fakeNotifier() {
  const sent = [];
  const resets = [];
  return {
    sent,
    resets,
    send: async (kind, title, message, opts) => {
      sent.push({ kind, title, message, opts });
      return true;
    },
    reset: (kind) => resets.push(kind),
  };
}

test('login health recovers: a failure latches to failing, a later success returns it to ok', () => {
  const notifier = fakeNotifier();
  const logs = [];
  const { health, noteLogin } = createHealthTracker(notifier, (m) => logs.push(m));

  noteLogin(false, 'Jackett search: HTTP 500');
  assert.equal(health.hebitsLogin, 'failing');
  assert.equal(health.error, 'Jackett search: HTTP 500');
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login']);

  // A second failure while already failing must not re-fire (state unchanged).
  noteLogin(false, 'Jackett search: HTTP 500');
  assert.equal(health.hebitsLogin, 'failing');
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login']);

  noteLogin(true);
  assert.equal(health.hebitsLogin, 'ok');
  assert.equal(health.error, null);
  assert.deepEqual(notifier.resets, ['login']);
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login', 'login-ok']);
});

test('a first-ever success (cold start) transitions unknown -> ok and is not swallowed', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  assert.equal(health.hebitsLogin, 'unknown');
  noteLogin(true);
  assert.equal(health.hebitsLogin, 'ok');
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login-ok']);
});
