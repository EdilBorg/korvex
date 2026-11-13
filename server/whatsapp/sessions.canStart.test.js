'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('./sessions');

describe('canStartNewConnection', () => {
  const uid = 'test-uid-reconnect';

  beforeEach(() => {
    sessions.remove(uid);
  });

  it('allows when there is no session', () => {
    assert.equal(sessions.canStartNewConnection(uid), true);
  });

  it('blocks while connecting', () => {
    sessions.set(uid, { state: 'connecting', status: 'connecting', socket: {} });
    assert.equal(sessions.canStartNewConnection(uid), false);
  });

  it('blocks while connected', () => {
    sessions.set(uid, { state: 'connected', status: 'connected', socket: {} });
    assert.equal(sessions.canStartNewConnection(uid), false);
  });

  it('allows reconnecting after previous connection closed (auto-reconnect)', () => {
    sessions.set(uid, {
      state: 'reconnecting',
      status: 'reconnecting',
      socket: null,
      qr: null,
    });
    assert.equal(sessions.canStartNewConnection(uid), true);
  });

  it('allows idle / failed / disconnected', () => {
    for (const state of ['idle', 'failed', 'disconnected']) {
      sessions.set(uid, { state, status: state, socket: null });
      assert.equal(sessions.canStartNewConnection(uid), true, `expected allow for ${state}`);
    }
  });
});
