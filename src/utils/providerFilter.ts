import type { LLMProvider } from '../types/app';

export const SIDEBAR_PROVIDERS: readonly LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];
export const SIDEBAR_PROVIDER_FILTER_STORAGE_KEY = 'sidebar-provider-filter';

const PROVIDER_SET = new Set<string>(SIDEBAR_PROVIDERS);

export function normalizeProviderFilter(value: unknown): LLMProvider[] {
  if (!Array.isArray(value)) {
    return [...SIDEBAR_PROVIDERS];
  }

  const providers = SIDEBAR_PROVIDERS.filter((provider) => value.includes(provider));
  return providers.length > 0 ? providers : [...SIDEBAR_PROVIDERS];
}

export function readProviderFilter(): LLMProvider[] {
  try {
    const stored = localStorage.getItem(SIDEBAR_PROVIDER_FILTER_STORAGE_KEY);
    return stored ? normalizeProviderFilter(JSON.parse(stored)) : [...SIDEBAR_PROVIDERS];
  } catch {
    return [...SIDEBAR_PROVIDERS];
  }
}

export function writeProviderFilter(providers: readonly LLMProvider[]): void {
  try {
    localStorage.setItem(
      SIDEBAR_PROVIDER_FILTER_STORAGE_KEY,
      JSON.stringify(normalizeProviderFilter(providers)),
    );
  } catch {
    // Storage can be disabled; the in-memory selection still remains usable.
  }
}

export function isProviderSelected(
  providers: readonly LLMProvider[],
  provider: unknown,
): provider is LLMProvider {
  return typeof provider === 'string' && PROVIDER_SET.has(provider) && providers.includes(provider as LLMProvider);
}

export function getProviderApiFilter(providers: readonly LLMProvider[]): LLMProvider[] | undefined {
  const normalized = normalizeProviderFilter(providers);
  return normalized.length === SIDEBAR_PROVIDERS.length ? undefined : normalized;
}
