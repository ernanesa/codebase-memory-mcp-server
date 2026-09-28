import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDelayMilliseconds } from '../src/retry.js';

test('retry usa backoff exponencial com jitter', () => {
  assert.equal(retryDelayMilliseconds({ attempt: 1, random: () => 0 }), 250);
  assert.equal(retryDelayMilliseconds({ attempt: 2, random: () => 1 }), 600);
});

test('Retry-After em segundos e data HTTP define o atraso mínimo', () => {
  assert.equal(retryDelayMilliseconds({ attempt: 1, retryAfter: '3', now: 0, random: () => 0 }), 3_000);
  assert.equal(retryDelayMilliseconds({ attempt: 1, retryAfter: new Date(5_000).toUTCString(), now: 0, random: () => 0 }), 5_000);
});

test('valores inválidos usam backoff e atrasos são limitados', () => {
  assert.equal(retryDelayMilliseconds({ attempt: 1, retryAfter: 'invalid', random: () => 0 }), 250);
  assert.equal(retryDelayMilliseconds({ attempt: 6, retryAfter: '120', now: 0, random: () => 1 }), 30_000);
});
