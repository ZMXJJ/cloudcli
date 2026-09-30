import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getProviderApiFilter,
  normalizeProviderFilter,
  readProviderFilter,
  SIDEBAR_PROVIDER_FILTER_STORAGE_KEY,
  writeProviderFilter,
} from './providerFilter';

test('normalizeProviderFilter keeps canonical order and falls back to all', () => {
  assert.deepEqual(normalizeProviderFilter(['codex', 'claude']), ['claude', 'codex']);
  assert.deepEqual(normalizeProviderFilter([]), ['claude', 'codex', 'cursor', 'opencode']);
  assert.deepEqual(normalizeProviderFilter(['unknown']), ['claude', 'codex', 'cursor', 'opencode']);
});

test('getProviderApiFilter omits the default all-provider filter', () => {
  assert.equal(getProviderApiFilter(['claude', 'codex', 'cursor', 'opencode']), undefined);
  assert.deepEqual(getProviderApiFilter(['codex']), ['codex']);
});

test('provider filter persists and recovers from malformed storage', () => {
  const values = new Map<string, string>();
  const previousLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });

  try {
    writeProviderFilter(['codex', 'claude']);
    assert.deepEqual(readProviderFilter(), ['claude', 'codex']);

    values.set(SIDEBAR_PROVIDER_FILTER_STORAGE_KEY, '{bad json');
    assert.deepEqual(readProviderFilter(), ['claude', 'codex', 'cursor', 'opencode']);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: previousLocalStorage,
    });
  }
});
