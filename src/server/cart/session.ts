import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ForbiddenError, ValidationError } from "@/lib/errors";

export const GUEST_CART_COOKIE = "inkline_cart_session";
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A guest token is unguessable, opaque, and only ever sent in an HttpOnly cookie. */
export function newGuestCartToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Store a one-way digest, not the browser's bearer token. */
export function guestCartSessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function guestCartTokenFromRequest(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const split = part.indexOf("=");
    if (split < 0 || part.slice(0, split).trim() !== GUEST_CART_COOKIE) continue;
    let value = part.slice(split + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return GUEST_TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

function secureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return process.env.NODE_ENV === "production" || forwarded === "https" || new URL(request.url).protocol === "https:";
}

export function guestCartSetCookie(request: Request, token: string, maxAgeSeconds: number): string {
  const parts = [
    `${GUEST_CART_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
  ];
  if (secureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

export function guestCartClearCookie(request: Request): string {
  return guestCartSetCookie(request, "", 0);
}

export function appendSetCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Mutations are JSON-only and SameSite=Lax. When browsers provide Origin or
 * Sec-Fetch-Site, reject a cross-origin write before reading any body/cookie.
 */
export function assertSameOriginJsonMutation(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ValidationError("Send this request as JSON.");
  }

  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new ForbiddenError("This request could not be verified.");
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const supplied = origin ?? referer;
  if (!supplied) return; // Non-browser clients still require the opaque guest token / authenticated session.

  let suppliedUrl: URL;
  try {
    suppliedUrl = new URL(supplied);
  } catch {
    throw new ForbiddenError("This request could not be verified.");
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? request.headers.get("host") ?? new URL(request.url).host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const requestProtocol = (forwardedProto ?? new URL(request.url).protocol.slice(0, -1)).toLowerCase();
  let expectedOrigin: string;
  try {
    if (requestProtocol !== "http" && requestProtocol !== "https") throw new Error("invalid protocol");
    expectedOrigin = new URL(`${requestProtocol}://${requestHost}`).origin.toLowerCase();
  } catch {
    throw new ForbiddenError("This request could not be verified.");
  }
  if (suppliedUrl.origin.toLowerCase() !== expectedOrigin) {
    throw new ForbiddenError("This request could not be verified.");
  }
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new ValidationError("A valid Idempotency-Key header is required.");
  }
  return key;
}
