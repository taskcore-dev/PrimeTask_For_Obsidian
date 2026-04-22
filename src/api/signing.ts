/**
 * ED25519 authorisation-request signing.
 *
 * Prevents plugin-ID impersonation. A malicious sideloaded plugin can claim
 * to be `primetask-sync` in its auth request body, but without the private
 * key held in the official build pipeline it cannot produce a signature
 * that PrimeTask's hardcoded public key will verify. The desktop app marks
 * the request as "unverified" and the modal shows an "Unknown source"
 * warning banner instead of the Trusted Integration badge.
 *
 * Key injection:
 *   - `__PRIMETASK_SIGNING_KEY__` is replaced at BUILD TIME by esbuild's
 *     `define` feature (see esbuild.config.mjs).
 *   - Release CI injects the key via the `PRIMETASK_SIGNING_KEY` env var.
 *   - Dev builds pick it up from a local `signing-key.private.pem` file
 *     (gitignored).
 *   - Fork builds with no key produce an empty string — every auth request
 *     goes out unsigned, landing in the "Unknown source" UX.
 *
 * Performance: ED25519 signing is ~50µs on any laptop. Invisible to the
 * user. No async, no hardware, no network.
 */

// Compile-time constant injected by esbuild. See esbuild.config.mjs.
declare const __PRIMETASK_SIGNING_KEY__: string;

/**
 * Sign an auth-request payload and return a base64-encoded signature,
 * or null if no signing key is available (fork build). Callers check for
 * null and omit the signature header accordingly.
 *
 * Payload format (fixed, verified byte-for-byte on the server):
 *   `${pluginId}|${nonce}|${signedAt}`
 *
 * `signedAt` is an ISO 8601 timestamp — the server rejects signatures older
 * than 5 minutes to prevent replay.
 */
export function signAuthRequest(pluginId: string, nonce: string, signedAt: string): string | null {
  const keyPem = typeof __PRIMETASK_SIGNING_KEY__ === 'string' ? __PRIMETASK_SIGNING_KEY__ : '';
  if (!keyPem || keyPem.trim().length === 0) return null;
  try {
    // Lazy-require so we don't pull Node crypto into the bundle until
    // we actually need to sign. Obsidian plugins run with full Node APIs
    // available in the renderer, so this resolves at runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    const privateKey = crypto.createPrivateKey(keyPem);
    const payload = `${pluginId}|${nonce}|${signedAt}`;
    // ED25519 takes null as the algorithm param — the key itself encodes it.
    const sig: Buffer = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
    return sig.toString('base64');
  } catch (err) {
    console.warn('[PrimeTask] Failed to sign auth request:', err);
    return null;
  }
}
