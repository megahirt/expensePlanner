// @vitest-environment node
/**
 * The release tooling: the version comes from the tag, and the store upload
 * signs in, uploads and submits in that order, never publishing a failed upload.
 * The store is faked; nothing here touches the network.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publishChrome, serviceAccountJwt, type FetchLike } from '../scripts/publish-chrome.mjs';
import { parseVersion, releaseVersion } from '../scripts/stamp-version.mjs';

describe('release version', () => {
  it('takes the version from the tag, with or without the v', () => {
    expect(releaseVersion({ RELEASE_VERSION: 'v1.4.0' })).toBe('1.4.0');
    expect(releaseVersion({ RELEASE_VERSION: '0.2.11' })).toBe('0.2.11');
  });

  it('refuses versions Chrome would reject', () => {
    for (const bad of ['1.2', '1.02.0', 'v1.2.3-beta', '1.2.70000', 'latest']) {
      expect(() => parseVersion(bad), bad).toThrow('not X.Y.Z');
    }
  });

  it('falls back to 0.0.0 when there is nothing to go on', () => {
    expect(parseVersion(undefined)).toBe('0.0.0');
    expect(parseVersion('')).toBe('0.0.0');
  });
});

// A throwaway key, made for the test (never a real service account).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  client_email: 'ci@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://oauth2.googleapis.com/token',
};
const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
const zip = { name: 'x-chrome.zip', data: Buffer.from('PK fake zip') };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake store: records each request and answers from a script. */
function fakeStore(answers: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const next = answers.shift();
    if (!next) throw new Error(`Unexpected request to ${url}`);
    return { ok: next.status < 400, status: next.status, statusText: '', text: async () => JSON.stringify(next.body) };
  };
  return { calls, fetchImpl };
}

const opts = (fetchImpl: FetchLike, extra: Record<string, unknown> = {}) => ({
  zip,
  key,
  publisherId: 'pub-123',
  itemId: ITEM,
  fetchImpl,
  log: () => {},
  sleep: async () => {},
  ...extra,
});

describe('Chrome Web Store upload', () => {
  it('signs a JWT for the store scope with the service account key', () => {
    const jwt = serviceAccountJwt(key, Date.UTC(2026, 10, 13));
    const [h, c, sig] = jwt.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: key.token_uri,
    });
    expect(claims.exp - claims.iat).toBe(3600);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  it("signs in, uploads the zip, then submits it staged, waiting for the owner's click", async () => {
    const { calls, fetchImpl } = fakeStore([
      { status: 200, body: { access_token: 'tok' } },
      { status: 200, body: { uploadState: 'SUCCEEDED', crxVersion: '1.1.2' } },
      { status: 200, body: { state: 'PENDING_REVIEW' } },
    ]);
    const published = await publishChrome(opts(fetchImpl));
    expect(published.state).toBe('PENDING_REVIEW');
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[1]).toMatchObject({
      url: `https://chromewebstore.googleapis.com/upload/v2/publishers/pub-123/items/${ITEM}:upload`,
      method: 'POST',
      body: zip.data,
    });
    expect(calls[1]?.headers.Authorization).toBe('Bearer tok');
    expect(calls[2]?.url).toBe(`https://chromewebstore.googleapis.com/v2/publishers/pub-123/items/${ITEM}:publish`);
    expect(JSON.parse(String(calls[2]?.body))).toEqual({ publishType: 'STAGED_PUBLISH' });
  });

  it('waits for an upload the store processes in the background', async () => {
    const { calls, fetchImpl } = fakeStore([
      { status: 200, body: { access_token: 'tok' } },
      { status: 200, body: { uploadState: 'IN_PROGRESS' } },
      { status: 200, body: { lastAsyncUploadState: 'IN_PROGRESS' } },
      { status: 200, body: { lastAsyncUploadState: 'SUCCEEDED' } },
      { status: 200, body: { state: 'PENDING_REVIEW' } },
    ]);
    await publishChrome(opts(fetchImpl));
    expect(calls.filter((c) => c.url.endsWith(':fetchStatus'))).toHaveLength(2);
  });

  it('stops with a clear error, and never publishes after a failed upload', async () => {
    const { calls, fetchImpl } = fakeStore([
      { status: 200, body: { access_token: 'tok' } },
      { status: 400, body: { error: { message: 'Invalid version' } } },
    ]);
    await expect(publishChrome(opts(fetchImpl))).rejects.toThrow('Upload failed (HTTP 400): Invalid version');
    expect(calls.some((c) => c.url.endsWith(':publish'))).toBe(false);
  });

  it('checks its settings before contacting the store', async () => {
    const { calls, fetchImpl } = fakeStore([]);
    await expect(publishChrome(opts(fetchImpl, { itemId: 'nope' }))).rejects.toThrow('CWS_EXTENSION_ID');
    await expect(publishChrome(opts(fetchImpl, { publisherId: '' }))).rejects.toThrow('CWS_PUBLISHER_ID');
    await expect(publishChrome(opts(fetchImpl, { publishType: 'NOW' }))).rejects.toThrow('CWS_PUBLISH_TYPE');
    expect(calls).toHaveLength(0);
  });
});
