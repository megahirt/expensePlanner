/** Types for publish-chrome.mjs, so its test can import it. */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
  }>;
}

export interface PublishOptions {
  zip: { name: string; data: Buffer };
  key: ServiceAccountKey;
  publisherId: string;
  itemId: string;
  publishType?: string;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  pollTries?: number;
}

export function serviceAccountJwt(key: ServiceAccountKey, now?: number): string;
export function accessToken(key: ServiceAccountKey, fetchImpl?: FetchLike, now?: number): Promise<string>;
export function publishChrome(options: PublishOptions): Promise<{ state?: string }>;
