import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError, parseProviderFilter } from '@/shared/utils.js';

test('parseProviderFilter returns undefined when no filter is supplied', () => {
  assert.equal(parseProviderFilter(undefined), undefined);
  assert.equal(parseProviderFilter(''), undefined);
});

test('parseProviderFilter normalizes and deduplicates supported providers', () => {
  assert.deepEqual(parseProviderFilter(' Claude, codex,claude '), ['claude', 'codex']);
});

test('parseProviderFilter rejects unsupported providers', () => {
  assert.throws(
    () => parseProviderFilter('claude,unknown'),
    (error: unknown) => error instanceof AppError
      && error.code === 'INVALID_PROVIDER_FILTER'
      && error.statusCode === 400,
  );
});
