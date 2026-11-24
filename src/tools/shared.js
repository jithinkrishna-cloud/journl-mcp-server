// Shared tool building blocks: input fields, output envelope, and the wrapper that
// authorizes, calls JournL, projects the result, handles errors and logs usage.
//
// Company scope: no tool accepts a company ID. The company always comes from the
// signed-in JournL session (the JournL JWT), so the model cannot choose another company.

import { z } from "zod";
import { get, JournlApiError, JournlAuthError } from "../services/journlClient.js";
import { denyReason } from "../services/permissions.js";
import { revokeSession } from "../auth/store.js";
import { logEvent, userRef } from "../utils/log.js";

export const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true });

// --- input fields --------------------------------------------------------------

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Not a valid date");

/** Required period, validated so startDate is not after endDate. */
export const period = {
  startDate: isoDate.describe("Period start date, YYYY-MM-DD (e.g. the first day of the financial year, 2025-04-01)."),
  endDate: isoDate.describe("Period end date, YYYY-MM-DD."),
};

export const branch = {
  branchId: z.number().int().positive().optional().describe("Optional branch ID. Only company owners can choose a branch; company users always see their assigned branch."),
  allBranches: z.boolean().optional().describe("Company owners only: true to report across all branches."),
};

export const maxRows = z.number().int().min(1).max(500).default(50).describe("Maximum rows to return (default 50, max 500). Totals always cover the full period.");

export const branchQuery = (a) => ({ branchId: a.branchId, allBranches: a.allBranches === undefined ? undefined : String(a.allBranches) });

// --- output envelope -----------------------------------------------------------

export const reportOutput = {
  company: z.string().nullable().describe("Company name."),
  currency: z.string().nullable().describe("Company currency code."),
  period: z.object({ startDate: z.string(), endDate: z.string() }).optional(),
  result: z.any().describe("Report data."),
  truncated: z
    .array(z.object({ list: z.string(), returned: z.number(), total: z.number() }))
    .optional()
    .describe("Lists shortened to maxRows."),
};

// --- plumbing -------------------------------------------------------------------

export const errorResult = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

export function sessionOf(extra) {
  const session = extra?.authInfo?.extra?.session;
  if (!session) throw new JournlAuthError();
  return session;
}

/** Wraps a tool handler with usage logging (tool name, outcome, duration; never arguments or data). */
export function logged(name, handler) {
  return async (args, extra) => {
    const started = performance.now();
    const result = await handler(args, extra);
    logEvent("tool_call", {
      tool: name,
      user: userRef(extra?.authInfo?.extra?.session),
      outcome: result?.isError ? "error" : "ok",
      ms: Math.round(performance.now() - started),
    });
    return result;
  };
}

/**
 * Registers a read-only tool backed by one JournL GET endpoint.
 *
 * @param {object} spec
 * @param {number[]} [spec.permission] feature IDs required for company users on routes
 *        JournL itself leaves unchecked (see services/permissions.js). Omit when JournL enforces it.
 * @param {string | ((args) => string)} spec.path JournL path, or a function of the tool arguments
 * @param {(data, args, truncated: object[]) => unknown} spec.project maps JournL `data` to the result
 */
export function reportTool(server, { name, title, description, inputSchema, path, permission, toQuery, project, summarize }) {
  server.registerTool(
    name,
    { title, description, inputSchema, outputSchema: reportOutput, annotations: { title, ...READ_ONLY } },
    logged(name, async (args, extra) => {
      let session;
      try {
        session = sessionOf(extra);
        if (args.startDate && args.endDate && args.startDate > args.endDate) {
          return errorResult("startDate must be on or before endDate.");
        }
        if (permission) {
          const reason = denyReason(session, permission);
          if (reason) return errorResult(reason);
        }

        const data = await get(typeof path === "function" ? path(args) : path, toQuery(args), session.journlToken);
        const truncated = [];
        const result = project(data, args, truncated);

        const structuredContent = {
          company: session.companyName,
          currency: session.currency,
          ...(args.startDate && args.endDate ? { period: { startDate: args.startDate, endDate: args.endDate } } : {}),
          result,
          ...(truncated.length ? { truncated } : {}),
        };
        const note = truncated.length ? " Some lists were shortened; ask for a narrower period or a larger maxRows to see more." : "";
        return { structuredContent, content: [{ type: "text", text: `${summarize(args)}${note}` }] };
      } catch (err) {
        if (err instanceof JournlAuthError) {
          if (session) revokeSession(session);
          return errorResult(err.message);
        }
        if (err instanceof JournlApiError) return errorResult(`JournL: ${err.message}`);
        logEvent("tool_failure", { tool: name, reason: err?.name ?? "Error" });
        return errorResult("Something went wrong while reading JournL. Please try again.");
      }
    }),
  );
}
