import type { NextConfig } from "next";

/**
 * Secure response headers (P5). The CSP keeps 'unsafe-inline' for scripts and styles because the Next.js runtime emits inline bootstrap code; a nonce-based CSP is the
 * hardening step for the UI stage and is listed as a residual risk. Everything else is as strict as the current pages allow (no framing, no object embeds, no
 * cross-origin form posts, no sniffing, no referrer, no powerful browser features). API responses are never cached.
 */
/**
 * The ONLY third-party origins the app allows, and only PayPal's SANDBOX ones, for the buyer's checkout button (PayPal JavaScript SDK v6 loads a script, opens its checkout in a
 * frame or popup and talks to PayPal). They are best-effort from PayPal's public documentation and are to be verified in the owner-approved Sandbox test; no production host is listed.
 */
export const PAYPAL_SANDBOX_ORIGINS = {
  script: "https://www.sandbox.paypal.com",
  connect: "https://www.sandbox.paypal.com https://api-m.sandbox.paypal.com",
  frame: "https://www.sandbox.paypal.com",
  img: "https://www.paypalobjects.com",
};

export const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline' ${PAYPAL_SANDBOX_ORIGINS.script}; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${PAYPAL_SANDBOX_ORIGINS.img}; connect-src 'self' ${PAYPAL_SANDBOX_ORIGINS.connect}; frame-src ${PAYPAL_SANDBOX_ORIGINS.frame}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
