import { createHmac, randomBytes } from "node:crypto";

/**
 * Minimal OAuth 1.0a HMAC-SHA1 request signing (RFC 5849) — exactly what the
 * X API v2 user-context endpoints accept, with zero dependencies. Verified
 * against the worked example in X's "Creating a signature" developer doc.
 */

export interface OAuth1Credentials {
  /** Consumer key (a.k.a. API key). */
  apiKey: string;
  /** Consumer secret (a.k.a. API secret). */
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** RFC 3986 percent-encoding — stricter than encodeURIComponent. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the `Authorization: OAuth ...` header value for one request.
 *
 * `params` must contain every query and form-encoded body parameter of the
 * request (JSON bodies are NOT part of an OAuth 1.0a signature). `timestamp`
 * and `nonce` are injectable for deterministic tests only.
 */
export function oauth1Header(opts: {
  method: string;
  /** Base URL of the request, without any query string. */
  url: string;
  params?: Record<string, string>;
  credentials: OAuth1Credentials;
  timestamp?: string;
  nonce?: string;
}): string {
  const { credentials } = opts;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const encodedPairs = Object.entries({ ...opts.params, ...oauthParams }).map(
    ([k, v]) => [percentEncode(k), percentEncode(v)] as const,
  );
  encodedPairs.sort(([ak, av], [bk, bv]) =>
    ak !== bk ? (ak < bk ? -1 : 1) : av < bv ? -1 : av > bv ? 1 : 0,
  );
  const paramString = encodedPairs.map(([k, v]) => `${k}=${v}`).join("&");

  const base = [
    opts.method.toUpperCase(),
    percentEncode(opts.url),
    percentEncode(paramString),
  ].join("&");
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");

  return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
}
