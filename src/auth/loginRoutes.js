// POST /login: the JournL sign-in form. On success, issues a single-use authorization
// code and redirects back to ChatGPT; the JournL password is never stored or logged.
//
// Browsers can submit the form twice (Enter + click, double click) while JournL's login
// is still running. The pending login owns its attempt: a repeat submit waits for the
// running attempt and, after success, receives the same redirect until the code expires,
// instead of an "expired" page that would strand ChatGPT without its code.

import express from "express";
import { config } from "../config/index.js";
import { login } from "../services/journlClient.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { logEvent, userRef } from "../utils/log.js";
import { errorPage, loginPage } from "./loginPage.js";
import { sendHtml } from "./html.js";
import { getPendingLogin, putAuthCode } from "./store.js";

const failures = createRateLimiter({ limit: config.loginFailureLimit, windowMs: config.loginFailureWindowMs });

/** Runs one sign-in attempt. Resolves to { redirect } or { status, error }. */
async function attemptLogin(pending, email, password, ip) {
  if (failures.isLimited(ip)) return { status: 429, error: "Too many failed attempts. Please wait a few minutes and try again." };
  if (!email || !password || email.length > 254 || password.length > 256) return { status: 400, error: "Enter your email and password." };

  let result;
  try {
    result = await login(email, password);
  } catch (err) {
    logEvent("login_error", { reason: err?.name ?? "Error" });
    return { status: 502, error: "JournL could not be reached. Please try again." };
  }
  if (!result.ok) {
    failures.hit(ip);
    logEvent("login_failed");
    return { status: 401, error: result.message };
  }

  const code = putAuthCode({
    clientId: pending.clientId,
    params: pending.params,
    session: result.session,
    expiresAtMs: Date.now() + config.authCodeTtlMs,
  });
  logEvent("login_succeeded", { user: userRef(result.session), role: result.session.role });

  const target = new URL(pending.params.redirectUri);
  target.searchParams.set("code", code);
  if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
  return { redirect: target.href };
}

export const loginRouter = express.Router();

loginRouter.post("/login", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
  const pendingId = typeof req.body?.pending === "string" ? req.body.pending : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const pending = getPendingLogin(pendingId);
  if (!pending) return sendHtml(res, 400, errorPage("This sign-in link has expired. Return to ChatGPT and connect JournL again."));

  let outcome;
  if (pending.redirect) {
    outcome = { redirect: pending.redirect }; // already signed in: repeat the same redirect
  } else {
    // Share one in-flight attempt between duplicate submits of this form.
    pending.attempt ??= attemptLogin(pending, email, password, req.ip).finally(() => {
      pending.attempt = undefined;
    });
    outcome = await pending.attempt;
    if (outcome.redirect && !pending.redirect) {
      // Keep the pending login only as long as its code is valid, so it cannot mint another code.
      pending.redirect = outcome.redirect;
      pending.expiresAtMs = Date.now() + config.authCodeTtlMs;
    }
  }

  if (outcome.redirect) return res.set("Cache-Control", "no-store").redirect(302, outcome.redirect);
  return sendHtml(res, outcome.status, loginPage({ pendingId, clientName: pending.clientName, error: outcome.error, email }));
});
