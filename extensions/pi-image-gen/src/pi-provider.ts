import { ImageGenError } from './errors.js';
import type { ImageModelRegistry, ResolvedProvider } from './types.js';

// Not meaningful to forward from a provider config onto a JSON/multipart image request.
const DROPPED_HEADERS = new Set(['content-type', 'content-length', 'host', 'transfer-encoding']);

function fail(provider: ResolvedProvider, detail: string): never {
  const ref = provider.piRef;
  const target = ref ? `${ref.provider}/${ref.model}` : provider.id;
  throw new ImageGenError(
    `Pi provider route "${provider.id}" (${target}) cannot be used: ${detail} No other provider or credential was tried.`,
    `pi provider route ${provider.id} unavailable`,
  );
}

/**
 * Bind a Pi-provider route to the endpoint and request-time authentication Pi
 * resolves for the explicitly referenced model. The result carries the final
 * header set (null deletion markers applied) with `customAuth: none`, so the
 * adapter sends exactly these headers to exactly this base URL. Routes without
 * `piRef` are returned unchanged. Never falls back to another provider.
 */
export async function bindPiProvider(
  provider: ResolvedProvider,
  registry: ImageModelRegistry | undefined,
): Promise<ResolvedProvider> {
  const ref = provider.piRef;
  if (!ref) return provider;
  if (!registry?.find) fail(provider, 'the Pi model registry is unavailable or lacks model lookup.');

  const model = registry.find(ref.provider, ref.model);
  if (!model) fail(provider, 'the referenced Pi model is not configured.');
  // An OAuth login (e.g. openai-codex) is bound to its own fixed endpoint and
  // protocol; never attach it to this Images API route.
  let oauth = ref.provider === 'openai-codex';
  try {
    oauth = oauth || registry.isUsingOAuth?.(model) === true;
  } catch {
    oauth = true;
  }
  if (oauth) fail(provider, 'OAuth-backed Pi providers are not supported by this route.');

  let auth: Awaited<ReturnType<ImageModelRegistry['getApiKeyAndHeaders']>>;
  try {
    auth = await registry.getApiKeyAndHeaders(model);
  } catch {
    fail(provider, 'Pi could not resolve request authentication.');
  }
  if (!auth.ok) fail(provider, 'Pi has no usable authentication for it.');

  const baseUrl = (auth.baseUrl ?? model.baseUrl ?? '').trim();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    fail(provider, 'it has no valid base URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  ) {
    fail(provider, 'its base URL must be https (or loopback http) without embedded credentials.');
  }

  // Pi ProviderHeaders: a null value deletes that header (and, for Authorization,
  // also suppresses the Bearer derived from apiKey). Nulls are never sent.
  const headers: Record<string, string> = {};
  let authorizationSuppressed = false;
  const piHeaders = (auth.headers ?? {}) as Record<string, string | null>;
  for (const [name, value] of Object.entries(piHeaders)) {
    const lower = name.toLowerCase();
    if (value === null) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lower) delete headers[existing];
      }
      if (lower === 'authorization') authorizationSuppressed = true;
      continue;
    }
    if (typeof value !== 'string' || DROPPED_HEADERS.has(lower)) continue;
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing];
    }
    headers[name] = value;
  }
  const hasAuthorization = Object.keys(headers).some((n) => n.toLowerCase() === 'authorization');
  if (!hasAuthorization && !authorizationSuppressed && auth.apiKey) {
    headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  if (Object.keys(headers).length === 0) fail(provider, 'Pi resolved no credential headers.');

  const { apiKey: _unused, ...rest } = provider;
  return {
    ...rest,
    baseUrl: url.toString(),
    headers,
    customAuth: { type: 'none' },
  };
}
