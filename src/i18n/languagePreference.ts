import { languages } from './languages';

export const LANGUAGE_STORAGE_KEY = 'userLanguage';
export const LANGUAGE_PREFERENCE_MODE_KEY = 'userLanguagePreferenceMode';
export const MANUAL_LANGUAGE_PREFERENCE = 'manual';

const DEFAULT_LANGUAGE = 'en';
const TRADITIONAL_CHINESE_REGIONS = new Set(['hk', 'mo', 'tw']);
const supportedLanguages = languages.map(({ value }) => value);
const supportedLanguageByCode = new Map(
  supportedLanguages.map((language) => [language.toLowerCase(), language]),
);

type LanguageStorage = Pick<Storage, 'getItem' | 'setItem'>;

function getBrowserStorage(): LanguageStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function normalizeSupportedLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().replace(/_/g, '-');
  if (!normalized) return null;

  const exactMatch = supportedLanguageByCode.get(normalized.toLowerCase());
  if (exactMatch) return exactMatch;

  const parts = normalized.toLowerCase().split('-').filter(Boolean);
  const baseLanguage = parts[0];
  if (!baseLanguage) return null;

  if (baseLanguage === 'zh') {
    if (parts.includes('hant')) return 'zh-TW';
    if (parts.includes('hans')) return 'zh-CN';
    return parts.some((part) => TRADITIONAL_CHINESE_REGIONS.has(part)) ? 'zh-TW' : 'zh-CN';
  }

  return supportedLanguages.find(
    (language) => language.split('-')[0]?.toLowerCase() === baseLanguage,
  ) ?? null;
}

export function resolveSystemLanguage(systemLanguages: readonly unknown[]): string {
  for (const language of systemLanguages) {
    const supportedLanguage = normalizeSupportedLanguage(language);
    if (supportedLanguage) return supportedLanguage;
  }
  return DEFAULT_LANGUAGE;
}

export function resolveInitialLanguage(
  storedLanguage: unknown,
  preferenceMode: unknown,
  systemLanguages: readonly unknown[],
): string {
  const supportedStoredLanguage = normalizeSupportedLanguage(storedLanguage);
  const isManualPreference = preferenceMode === MANUAL_LANGUAGE_PREFERENCE;

  // Older versions wrote the default English value during initialization, so
  // an unmarked `en` cannot be treated as a deliberate user preference. Other
  // legacy values could only have come from the language selector.
  const isLegacyManualPreference = preferenceMode == null
    && supportedStoredLanguage !== null
    && supportedStoredLanguage !== DEFAULT_LANGUAGE;

  if (supportedStoredLanguage && (isManualPreference || isLegacyManualPreference)) {
    return supportedStoredLanguage;
  }

  return resolveSystemLanguage(systemLanguages);
}

export function getInitialLanguage(): string {
  const storage = getBrowserStorage();
  let storedLanguage: string | null = null;
  let preferenceMode: string | null = null;

  try {
    storedLanguage = storage?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
    preferenceMode = storage?.getItem(LANGUAGE_PREFERENCE_MODE_KEY) ?? null;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const systemLanguages = typeof navigator === 'undefined'
    ? []
    : [...(navigator.languages ?? []), navigator.language];

  return resolveInitialLanguage(storedLanguage, preferenceMode, systemLanguages);
}

export function saveManualLanguagePreference(
  language: unknown,
  storage: LanguageStorage | null = getBrowserStorage(),
): boolean {
  const supportedLanguage = normalizeSupportedLanguage(language);
  if (!supportedLanguage || !storage) return false;

  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, supportedLanguage);
    storage.setItem(LANGUAGE_PREFERENCE_MODE_KEY, MANUAL_LANGUAGE_PREFERENCE);
    return true;
  } catch {
    return false;
  }
}
