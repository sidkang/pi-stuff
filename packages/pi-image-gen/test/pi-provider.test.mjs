// Contract tests for Pi-provider routes. No network, no real credentials:
// the registry and fetch are fakes; secrets below are obvious fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateImage, resolveModel } from '../dist/index.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const KEY = 'FIXTURE-SECRET-KEY';

const settings = (extra = {}) => ({
  defaultProvider: 'pi-codex',
  defaultModel: 'gpt-image-2.5-flare',
  customProviders: {
    'pi-codex': {
      api: 'openai',
      piProvider: { provider: 'codex', model: 'gpt-6.1-sol' },
      models: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
    },
  },
  ...extra,
});

function fakeRegistry({ auth, model = { id: 'gpt-6.1-sol', provider: 'codex', baseUrl: 'https://gw.test/v1' }, oauth = false } = {}) {
  const calls = [];
  return {
    calls,
    getAvailable: () => [model],
    find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
    isUsingOAuth: () => oauth,
    getApiKeyAndHeaders: async (m) => {
      calls.push(m);
      return auth ?? { ok: true, apiKey: KEY, headers: {} };
    },
  };
}

function fakeFetch(respond) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url: String(url), init });
    return respond ? respond(url, init) : jsonOk();
  };
  impl.requests = requests;
  return impl;
}
const jsonOk = () =>
  new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function run(params, { s = settings(), registry, fetchImpl = fakeFetch(), omitRegistry = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pig-test-'));
  const options = { cwd, settings: s, fetchImpl };
  if (!omitRegistry) options.modelRegistry = registry ?? fakeRegistry();
  return { cwd, fetchImpl, result: await generateImage(params, options) };
}
const headerOf = (init, name) =>
  Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test('generation: Pi baseUrl + bearer from apiKey, 2.5 model/quality preserved', async () => {
  const { fetchImpl, result } = await run({ prompt: 'a fox', quality: 'xhigh', size: '1536x1024' });
  assert.equal(fetchImpl.requests.length, 1);
  const [{ url, init }] = fetchImpl.requests;
  assert.equal(url, 'https://gw.test/v1/images/generations');
  assert.equal(headerOf(init, 'authorization'), `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-image-2.5-flare');
  assert.equal(body.quality, 'xhigh');
  assert.equal(body.size, '1536x1024');
  assert.equal(result.images.length, 1);
});

test('Sunburst id passes through unchanged', async () => {
  const s = settings({ defaultModel: 'gpt-image-2.5-sunburst' });
  const { fetchImpl } = await run({ prompt: 'x', quality: 'max' }, { s });
  assert.equal(JSON.parse(fetchImpl.requests[0].init.body).model, 'gpt-image-2.5-sunburst');
});

test('edit with multiple references uses /images/edits with image[] and no forced content-type', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pig-test-'));
  const png = Buffer.from(PNG_B64, 'base64');
  await writeFile(join(cwd, 'a.png'), png);
  await writeFile(join(cwd, 'b.png'), png);
  const fetchImpl = fakeFetch();
  await generateImage(
    { prompt: 'merge', image: ['a.png', 'b.png'], quality: 'high' },
    { cwd, settings: settings(), fetchImpl, modelRegistry: fakeRegistry({ auth: { ok: true, apiKey: KEY, headers: { 'Content-Type': 'text/plain' } } }) },
  );
  const [{ url, init }] = fetchImpl.requests;
  assert.equal(url, 'https://gw.test/v1/images/edits');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'gpt-image-2.5-flare');
  assert.equal(init.body.getAll('image[]').length, 2);
  assert.equal(headerOf(init, 'content-type'), undefined, 'multipart boundary must be left to fetch');
  assert.equal(headerOf(init, 'authorization'), `Bearer ${KEY}`);
});

test('header null markers are deleted, never sent as text; null Authorization suppresses apiKey Bearer', async () => {
  const registry = fakeRegistry({
    auth: { ok: true, apiKey: KEY, headers: { Authorization: null, 'X-Placeholder': null, 'x-api-key': 'GW-KEY', 'X-Tenant': 't1' } },
  });
  const { fetchImpl } = await run({ prompt: 'x' }, { registry });
  const { init } = fetchImpl.requests[0];
  assert.equal(headerOf(init, 'authorization'), undefined);
  assert.equal(headerOf(init, 'x-placeholder'), undefined);
  assert.equal(headerOf(init, 'x-api-key'), 'GW-KEY');
  assert.equal(headerOf(init, 'x-tenant'), 't1');
  assert.ok(!Object.values(init.headers).some((v) => v === null || v === 'null'));
  assert.ok(!JSON.stringify(init.headers).includes(KEY), 'suppressed apiKey must not leak into another header');
});

test('a differently cased null Authorization deletes an earlier value and suppresses Bearer fallback', async () => {
  const registry = fakeRegistry({
    auth: { ok: true, apiKey: KEY, headers: { Authorization: 'Bearer OLD-FIXTURE', authorization: null, 'x-api-key': 'GW-KEY' } },
  });
  const { fetchImpl } = await run({ prompt: 'x' }, { registry });
  assert.equal(headerOf(fetchImpl.requests[0].init, 'authorization'), undefined);
  assert.equal(headerOf(fetchImpl.requests[0].init, 'x-api-key'), 'GW-KEY');
});

test('a differently cased null ordinary header deletes an earlier tenant value', async () => {
  const registry = fakeRegistry({
    auth: { ok: true, apiKey: KEY, headers: { 'X-Tenant': 'OLD-TENANT', 'x-tenant': null } },
  });
  const { fetchImpl } = await run({ prompt: 'x' }, { registry });
  assert.equal(headerOf(fetchImpl.requests[0].init, 'x-tenant'), undefined);
  assert.equal(headerOf(fetchImpl.requests[0].init, 'authorization'), `Bearer ${KEY}`);
});

test('explicit Authorization header from Pi wins over apiKey (no duplicate)', async () => {
  const registry = fakeRegistry({ auth: { ok: true, apiKey: KEY, headers: { authorization: 'Bearer FROM-HEADERS' } } });
  const { fetchImpl } = await run({ prompt: 'x' }, { registry });
  const h = fetchImpl.requests[0].init.headers;
  assert.deepEqual(Object.keys(h).filter((k) => k.toLowerCase() === 'authorization').length, 1);
  assert.equal(headerOf(fetchImpl.requests[0].init, 'authorization'), 'Bearer FROM-HEADERS');
});

test('endpoint and credential come from the same Pi resolution (auth.baseUrl wins over model.baseUrl)', async () => {
  const registry = fakeRegistry({ auth: { ok: true, apiKey: KEY, baseUrl: 'https://other.test/api/v1', headers: {} } });
  const { fetchImpl } = await run({ prompt: 'x' }, { registry });
  assert.equal(fetchImpl.requests.length, 1);
  assert.equal(fetchImpl.requests[0].url, 'https://other.test/api/v1/images/generations');
  assert.equal(fetchImpl.requests[0].init.redirect, 'error', 'credentials must not follow redirects');
});

test('401 is surfaced once: no retry, no fallback route, no secret in message', async () => {
  const fetchImpl = fakeFetch(() => new Response('{"error":"bad key FIXTURE-SECRET-KEY"}', { status: 401, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    () => run({ prompt: 'x' }, { fetchImpl }),
    (error) => {
      assert.ok(!String(error.message).includes(KEY));
      return true;
    },
  );
  assert.equal(fetchImpl.requests.length, 1);
});

for (const [name, opts] of Object.entries({
  'registry missing': { omitRegistry: true },
  'model not configured in Pi': { registry: { ...fakeRegistry(), find: () => undefined } },
  'Pi auth not ok': { registry: fakeRegistry({ auth: { ok: false, error: `no key ${KEY}` } }) },
  'ok but no credential at all': { registry: fakeRegistry({ auth: { ok: true, headers: {} } }) },
  'only null Authorization and apiKey': { registry: fakeRegistry({ auth: { ok: true, apiKey: KEY, headers: { Authorization: null } } }) },
  'OAuth-backed provider': { registry: fakeRegistry({ oauth: true }) },
  'no base URL': { registry: fakeRegistry({ model: { id: 'gpt-6.1-sol', provider: 'codex' } }) },
  'plain http non-loopback': { registry: fakeRegistry({ auth: { ok: true, apiKey: KEY, baseUrl: 'http://gw.test/v1' } }) },
  'URL with embedded credentials': { registry: fakeRegistry({ auth: { ok: true, apiKey: KEY, baseUrl: 'https://u:p@gw.test/v1' } }) },
})) {
  test(`fails closed without any request: ${name}`, async () => {
    const fetchImpl = fakeFetch();
    await assert.rejects(
      () => run({ prompt: 'x' }, { ...opts, fetchImpl }),
      (error) => {
        assert.ok(!String(error.message).includes(KEY));
        return true;
      },
    );
    assert.equal(fetchImpl.requests.length, 0);
  });
}

test('invalid local params never touch Pi credentials', async () => {
  const registry = fakeRegistry();
  await assert.rejects(() => run({ prompt: 'x', n: 99 }, { registry }));
  assert.equal(registry.calls.length, 0);
});

test('openai-codex provider id is rejected even if Pi does not report OAuth', async () => {
  const registry = fakeRegistry({ model: { id: 'gpt-5', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api' } });
  const s = settings({ customProviders: { 'pi-codex': { api: 'openai', piProvider: { provider: 'openai-codex', model: 'gpt-5' }, models: ['gpt-image-2.5-flare'] } } });
  const fetchImpl = fakeFetch();
  await assert.rejects(() => run({ prompt: 'x' }, { s, registry, fetchImpl }));
  assert.equal(fetchImpl.requests.length, 0);
  assert.equal(registry.calls.length, 0);
});

test('config: piProvider cannot be mixed with local endpoint/credential, other api styles, or an empty/missing model list', () => {
  const base = { api: 'openai', piProvider: { provider: 'codex', model: 'm' }, models: ['gpt-image-2.5-flare'] };
  const bad = [
    { ...base, apiKey: 'k' },
    { ...base, baseUrl: 'https://x.test/v1' },
    { ...base, headers: { a: 'b' } },
    { ...base, auth: { type: 'none' } },
    { ...base, api: 'codex' },
    { ...base, api: 'gemini' },
    { ...base, models: [] },
    { ...base, models: undefined },
    { ...base, piProvider: { provider: 'codex' } },
    { ...base, piProvider: { provider: 'codex', model: 'm', extra: 1 } },
  ];
  for (const entry of bad) {
    const r = resolveModel('gpt-image-2.5-flare', { defaultProvider: 'pi-codex', customProviders: { 'pi-codex': entry } });
    assert.ok('error' in r, JSON.stringify(entry));
  }
  const ok = resolveModel('gpt-image-2.5-flare', settings());
  assert.ok(!('error' in ok));
  assert.equal(ok.capabilities?.qualityValues?.includes('xhigh'), true, 'built-in 2.5 contract is inherited');
});

test('existing routes unchanged: openai-api still uses its own key and endpoint, ignoring Pi registry', async () => {
  const s = { defaultProvider: 'openai-api', defaultModel: 'gpt-image-2.5-flare', providers: { openai: { apiKey: 'LOCAL-KEY' } } };
  const registry = fakeRegistry();
  const { fetchImpl } = await run({ prompt: 'x' }, { s, registry });
  assert.equal(fetchImpl.requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(headerOf(fetchImpl.requests[0].init, 'authorization'), 'Bearer LOCAL-KEY');
  assert.equal(registry.calls.length, 0);
});

test('existing custom provider with local apiKey/baseUrl unchanged', async () => {
  const s = { defaultProvider: 'gw', defaultModel: 'gpt-image-2.5-flare', customProviders: { gw: { api: 'openai', baseUrl: 'https://own.test/v1', apiKey: 'OWN', models: ['gpt-image-2.5-flare'] } } };
  const { fetchImpl } = await run({ prompt: 'x' }, { s });
  assert.equal(fetchImpl.requests[0].url, 'https://own.test/v1/images/generations');
  assert.equal(headerOf(fetchImpl.requests[0].init, 'authorization'), 'Bearer OWN');
});
