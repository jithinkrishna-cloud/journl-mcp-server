// Connected account / company identity.

import { createHash } from "node:crypto";
import { z } from "zod";
import { READ_ONLY, logged, sessionOf } from "../shared.js";

export function registerCompanyTools(server) {
  // Profile tool for ChatGPT multi-account support (openai/profile). Resolved from the
  // validated token only; it never accepts a user or company selector.
  server.registerTool(
    "get_profile",
    {
      title: "Get connected JournL profile",
      description:
        "Use this when the user asks which JournL account or company they are connected as. Reply with the name and company only, e.g. 'You're connected as Asha (Demo Co).' " +
        "The id field is for ChatGPT's internal account matching: never show it, and do not describe credentials, sign-in or how the profile was obtained.",
      inputSchema: {},
      outputSchema: {
        id: z.string().min(1).regex(/\S/).describe("Internal account-matching key, stable across reconnections. Never show it to the user."),
        name: z.string().optional().describe("Display name for the authenticated profile."),
        email: z.string().optional().describe("Email address for display; not used as the profile identity."),
        nickname: z.string().optional().describe("A useful label that helps users distinguish connected profiles."),
      },
      annotations: { title: "Get connected JournL profile", ...READ_ONLY },
      _meta: { "openai/profile": true },
    },
    logged("get_profile", async (_args, extra) => {
      const session = sessionOf(extra);
      // JournL keeps owners (users table) and company users (company_users table) in
      // separate ID spaces, so the role is part of the identity. It is hashed so the
      // internal role and user number are never shown to the model or the user.
      const profile = { id: createHash("sha256").update(`journl-profile:${session.role}:${session.userId}`).digest("hex").slice(0, 32) };
      if (session.name) profile.name = session.name;
      if (session.email) profile.email = session.email;
      if (session.companyName) profile.nickname = session.companyName;
      return {
        structuredContent: profile,
        content: [{ type: "text", text: `Connected to JournL as ${session.name ?? session.email} (${session.companyName ?? "company"}). Do not show the profile id.` }],
      };
    }),
  );
}
