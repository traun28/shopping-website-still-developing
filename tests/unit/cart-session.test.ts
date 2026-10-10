import { describe, expect, it } from "vitest";
import {
  GUEST_CART_COOKIE,
  assertSameOriginJsonMutation,
  guestCartSessionHash,
  guestCartSetCookie,
  guestCartTokenFromRequest,
  newGuestCartToken,
  requireIdempotencyKey,
} from "@/server/cart/session";

describe("guest cart session security", () => {
  it("issues an unguessable cookie token and stores a stable one-way digest", () => {
    const token = newGuestCartToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(guestCartSessionHash(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(guestCartSessionHash(token)).not.toBe(token);
    expect(guestCartSessionHash(token)).toBe(guestCartSessionHash(token));
    expect(guestCartSessionHash(newGuestCartToken())).not.toBe(guestCartSessionHash(token));
  });

  it("parses only valid cart tokens from the HttpOnly cookie name", () => {
    const token = newGuestCartToken();
    const request = new Request("https://shop.test/cart", {
      headers: { cookie: `other=hello; ${GUEST_CART_COOKIE}=${token}` },
    });
    expect(guestCartTokenFromRequest(request)).toBe(token);
    expect(guestCartTokenFromRequest(new Request("https://shop.test", { headers: { cookie: `${GUEST_CART_COOKIE}=short` } }))).toBeNull();
    expect(guestCartTokenFromRequest(new Request("https://shop.test", { headers: { cookie: "other=value" } }))).toBeNull();
  });

  it("sets an HttpOnly, same-site, scoped cookie without Domain", () => {
    const token = newGuestCartToken();
    const request = new Request("http://shop.test/api/cart", { headers: { "x-forwarded-proto": "https" } });
    const cookie = guestCartSetCookie(request, token, 3600);
    expect(cookie).toContain(`${GUEST_CART_COOKIE}=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("requires JSON and rejects cross-origin mutation requests", () => {
    const ok = new Request("https://shop.test/api/cart", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://shop.test", host: "shop.test" },
    });
    expect(() => assertSameOriginJsonMutation(ok)).not.toThrow();

    const crossOrigin = new Request("https://shop.test/api/cart", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test", host: "shop.test" },
    });
    expect(() => assertSameOriginJsonMutation(crossOrigin)).toThrow(/request could not be verified/i);

    const wrongScheme = new Request("https://shop.test/api/cart", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://shop.test", host: "shop.test" },
    });
    expect(() => assertSameOriginJsonMutation(wrongScheme)).toThrow(/request could not be verified/i);

    const formPost = new Request("https://shop.test/api/cart", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "shop.test" },
    });
    expect(() => assertSameOriginJsonMutation(formPost)).toThrow(/send this request as json/i);
  });

  it("validates idempotency key length and characters", () => {
    const keyRequest = (key: string) => new Request("https://shop.test", { headers: { "idempotency-key": key } });
    expect(requireIdempotencyKey(keyRequest("retry-1234"))).toBe("retry-1234");
    expect(() => requireIdempotencyKey(keyRequest("short"))).toThrow(/idempotency-key/i);
    expect(() => requireIdempotencyKey(keyRequest("bad key 123"))).toThrow(/idempotency-key/i);
  });
});
