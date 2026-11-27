// JournL MCP server: an Express adapter between ChatGPT and JournL's existing API.
//
//   POST /mcp                 JournL tools, read-only unless ENABLE_WRITE_TOOLS=true (streamable HTTP, OAuth bearer required)
//   /.well-known/*, /authorize, /token, /register, /revoke   OAuth 2.1 (via the MCP SDK)
//   POST /login               JournL sign-in form submission
//   GET  /health              liveness check
//   GET  /                    public landing page

import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config/index.js";
import { oauthProvider } from "./auth/oauthProvider.js";
import { loginRouter } from "./auth/loginRoutes.js";
import { rateLimitRequests } from "./middleware/rateLimit.js";
import { logEvent, requestLog } from "./utils/log.js";
import { registerTools } from "./tools/index.js";
import { landingPage } from "./pages/landingPage.js";

// What ChatGPT is told it can change. Must match the tools actually registered.
const ACCESS = config.enableWriteTools
  ? "Access to the signed-in user's JournL company books: read reports, and create sales and purchase invoices. " +
    "To create an invoice, find the party with search_ledgers and the items with get_closing_stock, call create_sales_invoice or create_purchase_invoice without confirm to get a preview, " +
    "show the preview to the user, and call again with confirm true only after the user agrees. Existing entries cannot be edited or deleted. "
  : "Read-only access to the signed-in user's JournL company books. This server cannot create, edit or delete entries. ";

const INSTRUCTIONS =
  ACCESS +
  "Dates are YYYY-MM-DD; Indian financial years run 1 April to 31 March. " +
  "Get IDs first: search_ledgers before get_ledger_statement, list_ledger_groups before get_group_summary, search_vouchers before get_voucher, get_closing_stock before get_stock_item_statement. Prefer totals the tools return over adding rows. " +
  "Amounts are in the company currency. " +
  "Answer in plain business language. Never mention tool names, API endpoints, internal IDs (profile, ledger, group, voucher or stock IDs), " +
  "access tokens, passwords or how the data was retrieved, and do not add statements about what was or was not accessed. " +
  "Use IDs only to call the next tool; refer to ledgers, groups, vouchers and stock items by their names or numbers.";

const LANDING_HTML = landingPage();

const ICON_FILE =fileURLToPath(new URL("../assets/journl-icon.png", import.meta.url));
const STEPS_DIR = fileURLToPath(new URL("../assets/steps", import.meta.url));
const ICON_URL =new URL("icon.png", config.issuerUrl.href.replace(/\/?$/, "/")).href;

// Server identity, including the icon clients such as ChatGPT show next to the plugin name.
const SERVER_INFO = Object.freeze({
  name: "journl",
  title: "JournL",
  version: "0.1.0",
  icons: [{ src: ICON_URL, mimeType: "image/png", sizes: ["275x275"] }],
});

function createMcpServer() {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // behind one tunnel / load balancer: use the client IP for login rate limits
app.use(requestLog);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Public landing page. Same locked-down headers as the sign-in page, plus the server's own icon.
app.get("/", (_req, res) =>
  res
    .set({
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    })
    .type("html")
    .send(LANDING_HTML),
);

// OpenAI plugin portal domain verification: the exact token as plain text, nothing else.
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  if (!config.openaiAppsChallenge) return res.status(404).type("text/plain").send("Not configured");
  res.set("Cache-Control", "no-store").type("text/plain").send(config.openaiAppsChallenge);
});
app.get(["/icon.png", "/favicon.ico"], (_req, res) =>
  res.set("Cache-Control", "public, max-age=86400").type("png").sendFile(ICON_FILE),
);
// Screenshots for the landing page's connect steps.
app.use("/steps", express.static(STEPS_DIR, { index: false, maxAge: "1d", fallthrough: false }));

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: config.issuerUrl,
    resourceServerUrl: config.mcpResourceUrl,
    resourceName: "JournL",
  }),
);
app.use(loginRouter);

// OpenAI's docs show the metadata at the root path; serve the same document there too.
app.get("/.well-known/oauth-protected-resource", (_req, res) =>
  res.json({ resource: config.mcpResourceUrl.href, authorization_servers: [config.issuerUrl.href], resource_name: "JournL" }),
);

const requireAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpResourceUrl),
  expectedResource: config.mcpResourceUrl,
});

const perUserLimit = rateLimitRequests({
  limit: config.mcpRequestsPerMinute,
  windowMs: 60_000,
  keyOf: (req) => {
    const s = req.auth?.extra?.session;
    return `${s?.role}:${s?.userId}`;
  },
});

// Stateless streamable HTTP: a fresh server + transport per request, bound to that request's token.
app.post("/mcp", requireAuth, perUserLimit, express.json({ limit: "1mb" }), async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logEvent("mcp_failure", { reason: err?.name ?? "Error" });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless mode has no server-initiated stream or session to delete.
const methodNotAllowed = (_req, res) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", requireAuth, methodNotAllowed);
app.delete("/mcp", requireAuth, methodNotAllowed);

// Malformed JSON or other unhandled errors: a safe message, no stack traces.
app.use((err, _req, res, _next) => {
  const status = err?.status >= 400 && err?.status < 500 ? err.status : 500;
  if (status === 500) logEvent("http_failure", { reason: err?.name ?? "Error" });
  res.status(status).json({ error: status === 500 ? "Internal server error" : "Bad request" });
});

export function start(port = config.port) {
  const server = app.listen(port, () => {
    console.log(`JournL MCP server listening on port ${port}`);
    console.log(`  MCP endpoint:  ${config.mcpResourceUrl.href}`);
    console.log(`  JournL API:    ${config.journlApiBaseUrl.href}`);
  });
  server.requestTimeout = config.httpRequestTimeoutMs;
  server.headersTimeout = Math.min(config.httpRequestTimeoutMs, 30_000);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
