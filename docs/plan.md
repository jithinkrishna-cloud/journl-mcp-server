# JournL MCP Server — Build Plan

Source: OpenAI Plugins docs (developers.openai.com/plugins), read 2026-11-24:
concepts, plan/use-case, plan/tools, build/mcp-server, build/auth, build/plugins,
deploy/connect-chatgpt, deploy/app-review, deploy/troubleshooting,
guides/optimize-metadata, guides/security-privacy.

## Goal

A separate, read-only MCP server that lets ChatGPT answer accounting questions
from a user's authorised JournL company data, by calling JournL's existing
backend APIs. No change to JournL accounting logic, no duplicate database, no
OpenAI API inside JournL.

## Shape (per OpenAI "Choose a plugin shape")

**MCP server + skills** — no custom UI. Skills live in `plugin/skills/` and are
packaged by `npm run build:plugin`: `journl-month-end-review`,
`journl-receivables-followup`, `journl-gst-period-summary`,
`journl-bank-reconciliation`, `journl-party-reconciliation`. Each declares the
`journl` MCP server in `agents/openai.yaml`. Add UI only if a use case needs it.

### Reconciliation workflows (decided 2026-11-25)

| Workflow | Data today | Decision |
|---|---|---|
| Bank reconciliation | Bank ledger statement; bank statement uploaded by the user | **Skill** `journl-bank-reconciliation` (matching and BRS in the chat; cannot mark reconciled) |
| Party ledger reconciliation | Party ledger statement; party's statement uploaded by the user | **Skill** `journl-party-reconciliation` |
| GSTR-2B vs purchase register | `get_gst_r2b_report` + `search_vouchers` (Purchase), both paged at 50 | **Needs a server tool** that pages and matches by supplier invoice no., GSTIN and amount; too many rows to match reliably in the chat |
| GSTR-1 vs sales register | `get_gst_r1_report` + `search_vouchers` (Sales); B2CS is summarised, not per invoice | **Needs a server tool**; B2CS compared as totals by rate and place of supply |
| GSTR-3B summary | No 3B data: no ITC eligibility, reversals or cash/credit ledger balances | **Not supported.** `journl-gst-period-summary` covers the R1 and 2B totals side by side |

The upload-based skills depend on ChatGPT reading files the user uploads while
the plugin is active; confirm this in the local install before relying on them.

```
ChatGPT ──OAuth 2.1 + PKCE──► JournL MCP auth (in this server)
   │                                   │ verifies JournL login, picks company
   └──Bearer token──► /mcp (tools) ──► JournL API (user's JournL JWT)
```

## Stack

- Node.js + TypeScript, `@modelcontextprotocol/sdk`, `zod`
  (JournL server is Node/Express, so same team skills).
- Streamable HTTP transport at `/mcp`.
- Small store (Redis or a tiny table) only for OAuth codes/tokens and the
  token → JournL session mapping. **No accounting data stored.**

## Phase 1 — Use-case inventory (docs: plan/use-case)

| User goal | Example request | JournL endpoint | v1 |
|---|---|---|---|
| Account balances | "What's my cash balance?" | `/closing-balance`, `/ledgerItemSum/:ledgerId/:date` | yes |
| Ledger activity | "Show HDFC bank ledger for October" | `/ledger-statement`, `/general-ledger` | yes |
| Find a ledger | "Which ledgers are under Sundry Debtors?" | `/lookups/ledgers`, `/all-ledgers`, `/general-ledger-groups` | yes |
| Receivables / payables | "Who owes us more than 90 days?" | `/ageing-report`, `/customer-ledger`, `/supplier-ledger` | yes |
| Group summary | "Summarise expenses by group" | `/group-summery-report` | yes |
| Cash flow | "Cash flow this quarter" | `/cash-flow` | yes |
| GST | "GSTR-1 summary for September" | `/gst-r1-report`, `/gst-r2b-report`, `/gst-report` | yes |
| Stock | "Closing stock value" | `/closing-stock-report`, `/stock-item-report/:stockId` | yes |
| Dashboard | "How is the business doing this month?" | `companyDashboard` routes | yes |
| Create/edit vouchers | "Record a payment" | — | **excluded (read-only v1)** |

Each row becomes a test case (direct, indirect, negative prompts).
Confirm exact paths/params from `https://testapi.bizpolebooks.com/api-docs.json`.

## Phase 2 — Tool contracts (docs: plan/tools, optimize-metadata)

One focused tool per goal. Every tool:
- name `journl_<action>` (e.g. `get_account_balances`, `get_ledger_statement`,
  `search_ledgers`, `get_receivables_ageing`, `get_payables_ageing`,
  `get_group_summary`, `get_cash_flow`, `get_gst_r1_summary`,
  `get_gst_r2b_summary`, `get_stock_summary`, `get_business_overview`,
  `list_my_companies`, `get_profile`)
- description starting "Use this when…", with "Do not use for…"
- zod input schema (dates `YYYY-MM-DD`, ledger IDs from `search_ledgers`,
  bounded `limit`/paging) and output schema
- annotations: `readOnlyHint: true`, `destructiveHint: false`,
  `openWorldHint: false`
- result: concise `structuredContent` + short text; amounts with currency;
  stable IDs for follow-ups; no tokens, trace IDs or internal diagnostics
- `get_profile` marked `_meta["openai/profile"]: true`, returning a stable
  opaque id (JournL user id + company id), for multi-account support

Server `instructions` (<512 chars): read-only; call `search_ledgers` before
ledger-specific tools; dates are financial-year aware; amounts in INR.

## Phase 3 — Authentication (docs: build/auth) — **decision needed**

ChatGPT requires OAuth 2.1 auth-code + PKCE (S256). JournL only issues its own
JWTs, and `/auth/login-user` / `/auth/login-company-user` issue JWTs without a
password — **must not be used**.

Recommended (A): the MCP server hosts its own small OAuth authorization server:
1. `GET /.well-known/oauth-protected-resource` → resource + issuer.
2. `GET /.well-known/oauth-authorization-server` → issuer, authorize/token
   endpoints, `code_challenge_methods_supported: ["S256"]`,
   `client_id_metadata_document_supported: true` (CIMD) and/or
   `registration_endpoint` (DCR), `token_endpoint_auth_methods_supported: ["none"]`,
   `authorization_response_iss_parameter_supported: true` (return `iss`).
3. `/authorize`: our login page → user enters JournL credentials → verified
   against a JournL **password-checking** login API → user picks a company.
4. Issue our own access/refresh token with `aud` = MCP resource URL; map it
   server-side to the user's JournL JWT (encrypted, never returned to ChatGPT).
5. `/mcp` verifies issuer, audience, expiry, scope on every call; returns
   `401` + `WWW-Authenticate: Bearer resource_metadata=…` when missing/expired.
6. Allowlist the redirect URI shown in ChatGPT
   (`https://chatgpt.com/connector_platform_oauth_redirect` when iss is supported).

Alternatives: (B) add OAuth to JournL itself — modifies JournL;
(C) Auth0/Clerk — needs JournL account linking that doesn't exist.

Authorization: every tool call goes through JournL's API with the user's JWT,
so JournL's permission middleware (plan gate → admin → `user_permission.view`)
still decides access. The MCP server never bypasses it.

## Phase 4 — Build

1. Scaffold project, `McpServer` + streamable HTTP `/mcp`, health check.
2. `JournlClient`: typed GET wrapper (base URL from env, timeout, retries,
   maps JournL errors → clear tool errors; 401 → re-auth challenge).
3. OAuth layer (Phase 3).
4. Tools one at a time, starting with `get_profile`, `list_my_companies`,
   `search_ledgers`, `get_ledger_statement`.
5. Logging without tokens/PII; rate limits on heavy reports.

## Phase 5 — Test (docs: connect-chatgpt, troubleshooting)

1. `npx @modelcontextprotocol/inspector@latest` → Streamable HTTP
   `http://localhost:3000/mcp`: init, tool list, valid/invalid/unauthorised calls.
2. Expose via HTTPS tunnel (ngrok / Secure MCP Tunnel) against the **test API**.
3. ChatGPT → Plugins → + → Add custom MCP server → OAuth → Create as a plugin →
   install → Work chat → `@JournL`.
4. Run the golden prompt set (direct / indirect / follow-up / negative /
   cross-company access attempts). Record tool picked, args, result.
5. After metadata changes: redeploy → Refresh in ChatGPT Plugins → rerun.

## Phase 6 — Deploy & publish (docs: build/mcp-server, app-review)

- Stable public HTTPS (e.g. `https://mcp.journl…/mcp`), streaming not buffered
  by proxy, secrets in host secret store, logs/metrics.
- Optional: verify OpenAI mTLS client cert / ChatGPT IP ranges (extra layer,
  not a replacement for OAuth).
- Private/team use: stop at a custom MCP connection.
- Public listing: verified OpenAI org (business), `api.apps.write` permission,
  privacy policy + terms URLs, logo, test prompts & responses, Scan Tools in
  the submission portal, global (non-EU) data-residency project.

## Open questions

1. Auth approach — A (recommended), B or C?
2. Does JournL have a login API that verifies the password (and MFA)? The MCP
   login must use that.
3. Company-user vs company-admin logins — which roles may connect?
4. Hosting target and domain for the MCP server.
5. Personal/team use only, or public ChatGPT directory listing?
