import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LANGUAGE_PREFERENCE_MODE_KEY,
  LANGUAGE_STORAGE_KEY,
  MANUAL_LANGUAGE_PREFERENCE,
  normalizeSupportedLanguage,
  resolveInitialLanguage,
  resolveSystemLanguage,
  saveManualLanguagePreference,
} from './languagePreference';

test('system locale variants map to supported languages', () => {
  assert.equal(normalizeSupportedLanguage('en-US'), 'en');
  assert.equal(normalizeSupportedLanguage('fr-CA'), 'fr');
  assert.equal(normalizeSupportedLanguage('zh-SG'), 'zh-CN');
  assert.equal(normalizeSupportedLanguage('zh-HK'), 'zh-TW');
  assert.equal(normalizeSupportedLanguage('zh-Hans-SG'), 'zh-CN');
  assert.equal(normalizeSupportedLanguage('zh-Hant-HK'), 'zh-TW');
  assert.equal(normalizeSupportedLanguage('zh-Hans-TW'), 'zh-CN');
  assert.equal(normalizeSupportedLanguage('zh_TW'), 'zh-TW');
});

test('system language resolution checks later preferences before falling back', () => {
  assert.equal(resolveSystemLanguage(['es-MX', 'ja-JP']), 'ja');
  assert.equal(resolveSystemLanguage(['es-MX']), 'en');
});

test('manual language preference overrides the system language', () => {
  assert.equal(resolveInitialLanguage('en', MANUAL_LANGUAGE_PREFERENCE, ['zh-CN']), 'en');
  assert.equal(resolveInitialLanguage('de', MANUAL_LANGUAGE_PREFERENCE, ['zh-CN']), 'de');
});

test('legacy automatic English does not prevent following the system language', () => {
  assert.equal(resolveInitialLanguage('en', null, ['zh-CN']), 'zh-CN');
  assert.equal(resolveInitialLanguage('zh-CN', null, ['en-US']), 'zh-CN');
});

test('manual selection is explicitly persisted even when the language does not change', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(saveManualLanguagePreference('zh-HK', storage), true);
  assert.equal(values.get(LANGUAGE_STORAGE_KEY), 'zh-TW');
  assert.equal(values.get(LANGUAGE_PREFERENCE_MODE_KEY), MANUAL_LANGUAGE_PREFERENCE);
});
