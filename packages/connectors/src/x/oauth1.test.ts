import { describe, expect, it } from "vitest";
import { oauth1Header, percentEncode } from "./oauth1.js";

describe("oauth1 signing", () => {
  it("reproduces the worked example from X's 'Creating a signature' doc", () => {
    // Every input below is verbatim from the developer doc; the expected
    // signature is the doc's published result, independently re-verified
    // by HMAC-SHA1 over the doc's base string.
    const header = oauth1Header({
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json",
      params: {
        status: "Hello Ladies + Gentlemen, a signed OAuth request!",
        include_entities: "true",
      },
      credentials: {
        apiKey: "xvz1evFS4wEEPTGEFPHBog",
        apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    });
    expect(header).toContain(
      `oauth_signature="${percentEncode("hCtSmYh+iHYCEqBWrE7C7hYmtUk=")}"`,
    );
    expect(header.startsWith("OAuth ")).toBe(true);
    for (const field of [
      "oauth_consumer_key",
      "oauth_nonce",
      "oauth_signature_method=\"HMAC-SHA1\"",
      "oauth_timestamp",
      "oauth_token",
      "oauth_version=\"1.0\"",
    ]) {
      expect(header).toContain(field);
    }
  });

  it("percent-encodes RFC 3986 reserved characters that encodeURIComponent skips", () => {
    expect(percentEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("generates a fresh nonce per call when none is injected", () => {
    const opts = {
      method: "POST",
      url: "https://api.x.com/2/tweets",
      credentials: {
        apiKey: "k",
        apiSecret: "s",
        accessToken: "t",
        accessSecret: "ts",
      },
    };
    const a = oauth1Header(opts);
    const b = oauth1Header(opts);
    expect(a).not.toEqual(b);
  });
});
