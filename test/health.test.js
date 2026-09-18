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

test('cold start: unknown -> ok updates health but sends no notification', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  assert.equal(health.hebitsLogin, 'unknown');
  noteLogin(true);
  assert.equal(health.hebitsLogin, 'ok');
  assert.deepEqual(notifier.sent, []);
  assert.deepEqual(notifier.resets, []);
});

test('ok -> failing sends a login alert', () => {
  const notifier = fakeNotifier();
  const logs = [];
  const { health, noteLogin } = createHealthTracker(notifier, (m) => logs.push(m));

  noteLogin(true); // reach 'ok' silently first
  noteLogin(false, 'Jackett search: HTTP 500');
  assert.equal(health.hebitsLogin, 'failing');
  assert.equal(health.error, 'Jackett search: HTTP 500');
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login']);
});

test('failing -> ok sends login-ok and resets the login throttle', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(false, 'boom'); // reach 'failing' first
  noteLogin(true);
  assert.equal(health.hebitsLogin, 'ok');
  assert.equal(health.error, null);
  assert.deepEqual(notifier.resets, ['login']);
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login', 'login-ok']);
});

test('a repeated success while already ok sends nothing', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(true); // unknown -> ok
  noteLogin(true); // ok -> ok, unchanged
  assert.equal(health.hebitsLogin, 'ok');
  assert.deepEqual(notifier.sent, []);
});

test('a repeated failure while already failing does not re-fire', () => {
  const notifier = fakeNotifier();
  const { health, noteLogin } = createHealthTracker(notifier, () => {});

  noteLogin(false, 'boom');
  noteLogin(false, 'boom again');
  assert.equal(health.hebitsLogin, 'failing');
  assert.deepEqual(notifier.sent.map((s) => s.kind), ['login']);
});
