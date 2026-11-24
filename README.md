# JournL MCP Server

A read-only MCP server (Node.js + Express) that lets ChatGPT answer accounting
questions from a user's own JournL company books. It is an adapter: it calls
JournL's existing backend API with the user's own JournL session and stores no
accounting data. Design notes: [docs/plan.md](docs/plan.md).

```
ChatGPT ──HTTPS (MCP streamable HTTP + OAuth 2.1)──► JournL MCP Server
                                                       │ sign-in, company scope, feature permissions,
                                                       │ input validation, rate limits, safe errors
                                                       ▼
                                           Existing JournL backend API ──► JournL database
```

This is a **custom MCP connection**. It is a separate integration and does not
make JournL part of ChatGPT's built-in accounting integrations or partner list.

## Project layout

```
src/
  config/        environment configuration
  auth/          OAuth provider, token store, JournL sign-in page and route
  middleware/    rate limiting
  services/      JournL API client, feature-permission rules
  tools/         MCP tools: companies/ ledgers/ reports/ gst/ inventory/ (+ shared.js)
  utils/         logging, response projection
  server.js      Express app
tests/           end-to-end tests against a mock JournL API
```

## Deploy

Azure Container Apps: see [deploy/azure.md](deploy/azure.md) (Dockerfile + `deploy/containerapp.yaml`). Plugin ZIP for the OpenAI portal: `npm run build:plugin` (fill `plugin/plugin.env` first).

## Run locally

```bash
npm install
cp .env.example .env      # adjust values
npm run dev               # or: npm start
npm test                  # 26 end-to-end tests; uses a mock JournL, never real data
```

Requires Node.js 22.9+.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PUBLIC_URL` | Public HTTPS base URL of this server (no trailing slash) | `http://localhost:3100` |
| `PORT` | Listen port | `3100` |
| `JOURNL_API_BASE_URL` | JournL backend API | `https://testapi.bizpolebooks.com` |
| `JOURNL_TIMEOUT_MS` | Timeout per JournL call | `30000` |
| `PRIVACY_POLICY_URL` | Linked on the sign-in page (required for public listing) | – |
| `CLIENTS_FILE` | Registered OAuth clients (no tokens or accounting data) | `data/clients.json` |
| `LOGIN_FAILURE_LIMIT` | Failed sign-ins per IP per 15 min | `10` |
| `MCP_REQUESTS_PER_MINUTE` | MCP requests per user per minute | `120` |
| `HTTP_REQUEST_TIMEOUT_MS` | Incoming request timeout | `60000` |

No JournL database credentials or JWT secret are needed or used.

## MCP endpoint

```
https://<your-host>/mcp
```

Transport: streamable HTTP (stateless, `POST` only). Every request needs
`Authorization: Bearer <access token>` issued by this server's OAuth flow.

## Authentication setup

The server is its own OAuth 2.1 authorization server, backed by JournL's
password login:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` (and `/…/mcp`) | Protected-resource metadata |
| `/.well-known/oauth-authorization-server` | Authorization-server metadata (PKCE `S256`) |
| `/register` | Dynamic client registration (ChatGPT registers itself) |
| `/authorize` | Shows the JournL sign-in page |
| `/login` | Sign-in form; checks email/password with JournL `POST /auth/login` |
| `/token`, `/revoke` | Token exchange and revocation |

Flow: ChatGPT gets a `401` with a `WWW-Authenticate` header, discovers the
metadata, registers, and opens `/authorize`. The user signs in with their
JournL email and password; the server checks them with JournL and redirects
back to ChatGPT with a one-time code; ChatGPT exchanges it (PKCE) for an
access token bound to this server's `/mcp` resource.

- The JournL password is passed to JournL and never stored or logged.
- The JournL JWT stays in server memory, mapped to an opaque access token, and
  is never returned to ChatGPT.
- JournL's passwordless `/auth/login-user` and `/auth/login-company-user` are
  never used.
- Access lasts as long as the JournL session (8 hours). There is no refresh
  token; ChatGPT asks the user to sign in again.

## Connect from ChatGPT

1. Deploy the server, or expose it for testing: `ngrok http 3100`. Set
   `PUBLIC_URL` to the HTTPS URL and restart.
2. Check it: `npx @modelcontextprotocol/inspector@latest` → Streamable HTTP →
   `https://<your-host>/mcp`.
3. In ChatGPT open **Plugins → + → Add custom MCP server**:
   - Name: `JournL`
   - Server URL: `https://<your-host>/mcp`
   - Authentication: **OAuth** (client registration is automatic)
   - Accept the risk notice → **Create as a plugin**.
4. Install the plugin, start a **Work** chat, type `@`, pick JournL, and sign in
   with a JournL account when prompted.
5. After changing tools, select **Refresh** on the connection in ChatGPT Plugins.

Custom MCP servers must be allowed by the ChatGPT account or workspace admin.

## Required permissions

- **Who can connect:** JournL company owners (`company`) and company users
  (`company_user`) whose account is active. Blocked users, deleted companies,
  platform-admin roles and emails linked to several accounts cannot sign in.
- **Company scope:** no tool accepts a company ID. The company always comes from
  the signed-in JournL session.
- **Feature permissions:** JournL checks most reports itself. Where a JournL
  route only checks sign-in, this server requires the company user's `view`
  right for that feature (owners have full access, as in JournL):

| Tool | Checked by | Company-user feature needed |
|---|---|---|
| `search_ledgers` | JournL | General Ledger (2) or Ledger Statement (26) |
| `get_ledger_statement` | this server | Ledger Statement (26) or General Ledger (2) |
| `list_ledger_groups` | this server | Group Summary (38) or General Ledger (2) |
| `get_group_summary` | JournL | Group Summary (38) |
| `get_ageing_report` | JournL | Payable (36) / Receivable (37) ageing |
| `get_cash_flow` | this server + JournL plan | Cash Flow (48) |
| `get_gst_r1_report` / `get_gst_r2b_report` | JournL | GSTR-1 (39) / GSTR-2B (40) |
| `get_closing_stock` | this server | Closing Stock (28) |
| `get_business_summary` | JournL (hides restricted sections) | per section |
| `get_profit_and_loss` | this server | Profit & Loss (22) |
| `get_balance_sheet` | this server | Balance Sheet (23) |
| `search_vouchers` / `get_voucher` | this server | Day Book (24) |
| `get_trial_balance` | this server | owners only (feature ID not yet confirmed) |
| `get_top_customers` / `get_customer_insights` | this server | owners only (feature ID not yet confirmed) |
| `get_stock_item_statement` | this server | owners only (feature ID not yet confirmed) |
| `get_profile` | – | none |

## Tools and example calls

All tools are read-only (`readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`). Dates are `YYYY-MM-DD`. Results come back as
`{ company, currency, period?, result, truncated? }`.

| Tool | Example prompt | Example arguments |
|---|---|---|
| `get_profile` | "Which JournL account is connected?" | `{}` |
| `search_ledgers` | "Find my HDFC bank ledger" | `{ "search": "HDFC", "scope": "bank" }` |
| `get_ledger_statement` | "Show HDFC bank transactions for April 2025" | `{ "ledgerId": 5, "startDate": "2025-04-01", "endDate": "2025-04-30" }` |
| `list_ledger_groups` | "What account groups do we have?" | `{}` |
| `get_group_summary` | "Summarise indirect expenses for Q1" | `{ "groupId": 12, "startDate": "2025-04-01", "endDate": "2025-06-30" }` |
| `get_ageing_report` | "Who owes us more than 90 days?" | `{ "type": "receivable", "endDate": "2025-09-30" }` |
| `get_cash_flow` | "Cash flow this financial year" | `{ "startDate": "2025-04-01", "endDate": "2026-03-31" }` |
| `get_gst_r1_report` | "GSTR-1 for September 2025" | `{ "startDate": "2025-09-01", "endDate": "2025-09-30", "page": 1, "limit": 20 }` |
| `get_gst_r2b_report` | "GSTR-2B purchases for September" | `{ "startDate": "2025-09-01", "endDate": "2025-09-30" }` |
| `get_closing_stock` | "What's our closing stock value?" | `{ "startDate": "2025-04-01", "endDate": "2025-09-30" }` |
| `get_business_summary` | "How is the business doing this quarter?" | `{ "startDate": "2025-07-01", "endDate": "2025-09-30" }` |
| `get_profit_and_loss` | "Show my P&L for this year" | `{ "startDate": "2026-04-01", "endDate": "2026-11-24" }` |
| `get_balance_sheet` | "Show my balance sheet" | `{ "startDate": "2026-04-01", "endDate": "2026-11-24" }` |
| `get_trial_balance` | "Trial balance for this year" | `{ "startDate": "2026-04-01", "endDate": "2026-11-24" }` |
| `search_vouchers` | "Sales invoices this month" | `{ "voucherType": "Sales", "startDate": "2026-11-01", "endDate": "2026-11-24" }` |
| `get_voucher` | "What's in invoice 25?" | `{ "voucherId": 109 }` |
| `get_top_customers` | "Who are my biggest customers?" | `{ "startDate": "2026-04-01", "endDate": "2026-11-24" }` |
| `get_customer_insights` | "Which customers stopped buying?" | `{ "type": "inactive", "inactiveDays": 60 }` |
| `get_stock_item_statement` | "Movements of item 4 this year" | `{ "stockId": 4, "startDate": "2026-04-01", "endDate": "2026-11-24" }` |

Optional on most reports: `branchId`, `allBranches` (owners only), and `maxRows`
(default 50, max 500) for long lists.

## Security behaviour

- Every tool input is validated (types, date format and order, bounds).
- Responses contain only report fields; internal IDs, audit timestamps, password
  hashes and tokens are dropped.
- Timeouts: 30 s per JournL call, 60 s per incoming request.
- Rate limits: failed sign-ins per IP, MCP requests per user.
- Logs record event, tool name, outcome, duration and a hashed user reference,
  never tokens, passwords, tool arguments or accounting data.
- Errors are short and safe; JournL's own refusal messages are passed on.

## Known limits (v1)

- One instance only: sessions and rate limits are in memory, so a restart
  signs users out.
- Owners with several companies get the first company JournL returns.
- Permission changes in JournL reach company users after they reconnect.
- A user deactivated in JournL keeps access until their JournL session ends
  (up to 8 hours), the same as in JournL's own app.
- Tested end to end against a mock JournL; not yet verified with a real JournL
  login or in ChatGPT.
