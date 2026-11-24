// Structured logging. Never log tokens, passwords, tool arguments or accounting data:
// only event names, outcomes, durations and a pseudonymous user reference.

import { createHash } from "node:crypto";

/** Stable pseudonym for a user so logs can be correlated without storing who they are. */
export const userRef = (session) =>
  session ? createHash("sha256").update(`${session.role}:${session.userId}`).digest("hex").slice(0, 12) : null;

export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

/** Logs method, path (no query string), status and duration of each HTTP request. */
export function requestLog(req, res, next) {
  const started = performance.now();
  res.on("finish", () => {
    logEvent("http_request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
    });
  });
  next();
}
