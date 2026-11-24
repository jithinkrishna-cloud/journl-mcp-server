// Fixed-window, in-memory rate limiter. Bounded: expired windows are swept every minute.
// Single-instance only; use a shared store (e.g. Redis) when running several instances.

export function createRateLimiter({ limit, windowMs }) {
  const windows = new Map(); // key -> { count, resetAtMs }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAtMs <= now) windows.delete(key);
  }, 60_000);
  sweep.unref();

  const current = (key) => {
    const w = windows.get(key);
    return w && w.resetAtMs > Date.now() ? w : undefined;
  };

  return {
    /** True when `key` has used up its allowance in the current window. */
    isLimited(key) {
      return (current(key)?.count ?? 0) >= limit;
    },
    /** Counts one event for `key`. */
    hit(key) {
      const w = current(key);
      if (w) w.count += 1;
      else windows.set(key, { count: 1, resetAtMs: Date.now() + windowMs });
    },
    /** Seconds until `key`'s window resets. */
    retryAfterSeconds(key) {
      const w = current(key);
      return w ? Math.max(1, Math.ceil((w.resetAtMs - Date.now()) / 1000)) : 0;
    },
  };
}

/**
 * Express middleware limiting requests per key (after authentication).
 * Responds 429 with Retry-After when the limit is reached.
 */
export function rateLimitRequests({ limit, windowMs, keyOf }) {
  const limiter = createRateLimiter({ limit, windowMs });
  return (req, res, next) => {
    const key = keyOf(req);
    if (limiter.isLimited(key)) {
      res.set("Retry-After", String(limiter.retryAfterSeconds(key)));
      return res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "Too many requests. Please slow down and try again shortly." }, id: null });
    }
    limiter.hit(key);
    next();
  };
}
