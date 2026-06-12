# Security

`gmail-mcp-server` is designed to be **safe-by-default and auditable**. This document
summarizes the security model and how to report a vulnerability. The authoritative design
is in [docs/hld/GMAIL_MCP_SERVER_HLD.md](docs/hld/GMAIL_MCP_SERVER_HLD.md) (§16).

## Threat model

The server brokers an MCP client (and the model behind it) and your Gmail mailbox. The
primary risks it defends against are:

- **Prompt injection from email content.** Message bodies, subjects, snippets, sender
  names, and attachment filenames are **untrusted data**. The server never executes
  instructions found in email content — it only returns data — and its tool descriptions
  warn clients to treat that content as data, never as instructions.
- **Over-broad access.** Least privilege is enforced at two layers (scope + feature flag).
- **Accidental or malicious writes/sends.** Destructive and outbound actions require
  explicit confirmation and are off by default.
- **Path traversal and unsafe file writes.** Attachment saves are contained to a download
  root with extension/MIME/size/collision policies.
- **Token and content leakage** through logs or tool output.

## Controls

### No raw API passthrough

There is intentionally **no** `gmail_raw_request` / `run_gmail_api` / `execute_google_api`
escape hatch. Every capability is a specific, bounded tool.

### Scope and feature gating

A tool runs only if **both** are true:

1. its **feature flag** is enabled in local config; and
2. the granted OAuth token has a **sufficient scope** (any-of).

Otherwise the tool returns a structured `feature_disabled` or `insufficient_scope` error.
Read-oriented features default to `true`; write/optional features (`drafts`, `send`,
`modify`, `labelsWrite`, `history`) default to `false`. Use the narrowest scope profile
for your task; `https://mail.google.com/` (full mailbox) is discouraged unless required.

### Write-operation confirmation

Sending a message or draft requires confirmation when `requireConfirmationForSend` is on
(default). Trashing **always** requires confirmation. Label modifications require
confirmation when `requireConfirmationForModify` is on (default) or when more than one
message is targeted. When the client cannot prompt interactively, confirmation is supplied
via each tool's exact, case-sensitive `confirmation` input. The server never fabricates a
confirmation on the user's behalf.

### Attachment / filesystem safety

Saves are confined to the configured `downloads.rootDir`: absolute paths and `..`
traversal are rejected (`path_not_allowed`). Filenames are sanitized; blocked extensions
(`file_blocked`), a MIME allowlist (`mime_type_blocked`), and a per-file size cap
(`file_too_large`) are enforced, along with a collision policy. Bulk downloads have a
count cap and a confirmation threshold. Downloaded files are never opened or executed by
the server.

### Token safety

- OAuth tokens are **never** returned through MCP tools.
- Access and refresh tokens are **never** logged. As defense in depth,
  `safety.redactAccessTokensInLogs` (default `true`) scrubs token-shaped values from
  third-party/debug output; it is not a switch to enable token logging, which is
  prohibited regardless of its value.
- Tokens are stored under `~/.gmail-mcp/tokens/` with restrictive permissions where the
  platform allows; overly permissive token files trigger a warning.
- `auth revoke` calls Google's revocation endpoint when possible, then deletes the local
  token.

### Logging and audit

Default logs never include full message bodies or attachment bytes. The append-only audit
log (`logging.auditLogPath`) may record only allowlisted metadata — timestamp, tool, profile
email, message/thread ids, subject, sender, filenames, local paths, sha256, size, and result
status — and **never** OAuth tokens, full message bodies, attachment bytes, or full raw MIME.

### Response bounds

Every tool response is bounded by `toolResponseBodyCharLimit` and flagged when truncated;
message bodies are capped by `maxMessageBodyChars`.

## Transport

Local **stdio** is the default and recommended transport: tokens and mailbox content stay
on your machine. The optional HTTP transport binds to `127.0.0.1` by default (never
`0.0.0.0`); any remote exposure must add TLS and authentication.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
undisclosed vulnerability.

- Use GitHub's **"Report a vulnerability"** (Security → Advisories) on this repository, or
- email the maintainer at the address in the repository's Git history / `package.json`.

Include a description, reproduction steps, affected version/commit, and impact. We aim to
acknowledge reports promptly and will coordinate a fix and disclosure timeline with you.

## Scope of this software

This is not an official Google or Anthropic product. You are responsible for the scopes
you grant and the actions you enable. Review write/send features before turning them on.
