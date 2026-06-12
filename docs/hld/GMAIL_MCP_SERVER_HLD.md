# Gmail MCP Server — High-Level Design and Implementation Specification

> Purpose: this document is a self-contained product and engineering specification for building a general-purpose Gmail MCP server. It is intended to be handed to Claude Code or another coding agent so it can implement the project from scratch.

## 1. Project Summary

Build an open-source, general-purpose Model Context Protocol (MCP) server that exposes Gmail functionality to MCP-compatible clients such as Claude Code.

The server must let the end user decide what Gmail permissions/scopes they grant. The server must not hardcode a single use case such as invoices. It should support read-only, metadata-only, modify, compose, send, label, and full-mailbox modes depending on configuration and OAuth scopes.

The implementation must be safe-by-default, auditable, and suitable for public GitHub release. It should be useful both as:

1. a local personal MCP server over stdio; and
2. an optional HTTP MCP server for advanced/self-hosted use.

The first production-quality implementation should prioritize local stdio because it avoids exposing OAuth tokens or mailbox content to a remote service.

## 2. Primary Goals

1. Provide a clean MCP interface over Gmail API.
2. Support configurable OAuth scopes instead of assuming one fixed permission set.
3. Support Gmail attachments, including listing, downloading, saving to local filesystem, and returning attachment metadata.
4. Support safe message search, message reading, thread reading, labels, drafts, and optional send/modify tools.
5. Make granted capabilities explicit at runtime: if the user grants only read-only scopes, write tools must be unavailable or must return a clear scope error.
6. Avoid exposing a raw Gmail API passthrough tool.
7. Prevent path traversal, unsafe file writes, accidental bulk exfiltration, and prompt-injection-driven unsafe behavior.
8. Provide strong test coverage for MIME parsing, OAuth scope gating, path safety, pagination, attachment handling, and error handling.
9. Make the repository easy to install, configure, audit, and publish.

## 3. Non-Goals

1. Do not build a webmail client.
2. Do not build a background daemon that syncs the entire mailbox by default.
3. Do not store message bodies or attachments in a database by default.
4. Do not provide unrestricted filesystem access.
5. Do not provide a generic `gmail_raw_request` escape hatch.
6. Do not bypass Gmail OAuth consent or Google security controls.
7. Do not scrape Gmail web UI.
8. Do not implement service-account/domain-wide delegation in v1, except as a documented future enterprise extension.
9. Do not support outbound attachment uploads from the local filesystem in v1; the `attachmentsFromLocalPaths` input on the draft/send tools is reserved and must be empty (deferred to a future version with an explicit upload-root control).

## 4. External References

The implementation should be checked against the current official docs during development:

- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail attachments endpoint: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get
- Gmail attachments resource: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments
- Gmail messages API: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- Gmail drafts API: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts
- Gmail labels API: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels
- Gmail history API: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp

## 5. Important Gmail API Facts

1. Gmail attachment bytes are retrieved through `users.messages.attachments.get`.
2. The attachment endpoint requires one of these scopes:
   - `https://mail.google.com/`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.readonly`
3. Gmail message parts may contain either:
   - `body.data`, where the bytes are inline in the message part; or
   - `body.attachmentId`, where the bytes must be fetched separately.
4. `body.data` is base64url encoded.
5. Gmail search uses Gmail query syntax, for example:
   - `from:billing@example.com`
   - `has:attachment`
   - `newer:2026/01/01 older:2026/02/01`
   - `filename:pdf`
6. Gmail API scopes are OAuth scopes. They are the real Google-side authorization boundary. The MCP server must perform additional application-level authorization and safety checks, but these cannot make a broad Google OAuth token narrower from Google’s perspective.

## 6. Target Users

1. Individual users who want Claude Code to inspect or process their own Gmail.
2. Developers building local email automation workflows.
3. Security-conscious users who want to select Gmail OAuth scopes explicitly.
4. Teams that want a self-hosted MCP bridge to Gmail, subject to Google OAuth verification requirements.

## 7. Recommended Technology Stack

Use TypeScript/Node.js for v1.

Required packages:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "googleapis": "latest",
    "zod": "latest",
    "pino": "latest",
    "sanitize-filename": "latest",
    "mime-types": "latest",
    "open": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "tsx": "latest",
    "vitest": "latest",
    "eslint": "latest",
    "prettier": "latest",
    "@types/node": "latest"
  }
}
```

Notes:

- Prefer the stable production MCP SDK version. If the SDK has both v1 and v2/pre-release tracks, use the stable production track unless explicitly opting into v2.
- The code should isolate MCP SDK usage behind a thin layer so future SDK migration is manageable.

## 8. Runtime Modes

### 8.1 Local stdio mode

Default and recommended mode.

Example:

```bash
claude mcp add gmail -- npx gmail-mcp-server start --transport stdio
```

or during development:

```bash
claude mcp add gmail -- node ./dist/index.js start --transport stdio
```

### 8.2 HTTP mode

Optional advanced mode.

Use only when explicitly configured:

```bash
gmail-mcp-server start --transport http --host 127.0.0.1 --port 3333
```

Default HTTP binding must be `127.0.0.1`, not `0.0.0.0`.

If remote HTTP mode is supported later, it must require TLS and authentication.

## 9. OAuth Model

### 9.1 OAuth client type

For local personal usage, use Google OAuth Desktop App credentials.

Expected credential file:

```text
~/.gmail-mcp/credentials.json
```

Token file:

```text
~/.gmail-mcp/tokens/default.json
```

Support multiple profiles later:

```text
~/.gmail-mcp/tokens/personal.json
~/.gmail-mcp/tokens/work.json
```

### 9.2 Scope selection

The server must let users configure requested scopes.

Example config:

```json
{
  "activeProfile": "default",
  "oauth": {
    "scopes": [
      "https://www.googleapis.com/auth/gmail.readonly"
    ]
  }
}
```

The CLI should also support:

```bash
gmail-mcp-server auth login --scope-profile readonly
```

Supported built-in scope profiles:

| Profile | Scopes | Scope enum | Enables |
|---|---|---|---|
| `metadata` | `gmail.metadata` | `Scope.GmailMetadata` | profile, labels, message IDs, headers, search metadata where supported |
| `readonly` | `gmail.readonly` | `Scope.GmailReadonly` | search, read messages, read threads, read attachments |
| `modify` | `gmail.modify` | `Scope.GmailModify` | readonly + label add/remove, archive, trash, mark read/unread |
| `compose` | `gmail.compose` | `Scope.GmailCompose` | create/send drafts (the draft tools also require `features.drafts`, off by default), depending on Gmail behavior |
| `send` | `gmail.send` | `Scope.GmailSend` | send email only |
| `labels` | `gmail.labels` | `Scope.GmailLabels` | list labels; create labels only when `features.labelsWrite` is enabled (off by default; v1 supports list + create only, no update/delete) |
| `full` | `https://mail.google.com/` | `Scope.MailGoogleCom` | full Gmail mailbox access; strongly discouraged unless explicitly required |

Use the full OAuth URI values in code/config. The table may use short names only as aliases: each short name maps to the full OAuth URI `https://www.googleapis.com/auth/<short-name>` (for example, `gmail.metadata` → `https://www.googleapis.com/auth/gmail.metadata`, `gmail.compose` → `https://www.googleapis.com/auth/gmail.compose`, `gmail.send` → `https://www.googleapis.com/auth/gmail.send`, and `gmail.labels` → `https://www.googleapis.com/auth/gmail.labels`); `full` is the sole exception, whose full OAuth URI is `https://mail.google.com/`. The `Scope` enum members shown in the table correspond to those used in the §9.3 code examples.

Note: `archive`, `trash`, and `mark read/unread` are capabilities, not separate tools. Archiving and read/unread toggling are performed via `gmail_modify_message_labels` (e.g. removing `INBOX` to archive, adding/removing the `UNREAD` label); trashing is performed via `gmail_trash_messages`. Granting the `modify` scope authorizes these operations, but both tools are also gated by `features.modify` (off by default; see §10), so they are exposed only when that feature is enabled — consistent with §9.3 and §12.14/§12.15.

### 9.3 Scope gating

At runtime, every tool must declare required scopes.

Example:

```ts
const REQUIRED_SCOPES = {
  // Representative subset; each tool's authoritative required scopes are listed in its §12 spec.
  gmail_search_messages: [Scope.GmailMetadata, Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_get_attachment: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_save_attachment: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_send_message: [Scope.GmailSend, Scope.MailGoogleCom],
  gmail_modify_message_labels: [Scope.GmailModify, Scope.MailGoogleCom],
};
```

A tool is available only if:

1. the feature is enabled in local config; and
2. the granted OAuth token has sufficient scope.

If the MCP SDK supports dynamic tool registration/listing, hide unavailable tools. Otherwise register all tools and return a structured error when called: `feature_disabled` when the tool's feature flag is off, and `insufficient_scope` when the granted token lacks a required scope.

Every tool — read tools included — maps to exactly one feature flag in the §10 `features` object. Read-oriented features default to `true`; write-oriented and optional features default to `false`. The §12 tool specs explicitly restate this gating for the write-oriented and optional tools (and for the two save-attachment tools, which add a `downloads.enabled` gate); the remaining read tools are gated by the same mechanism and rely on the mapping below:

| Feature flag | Default | Tools gated |
|---|---|---|
| `profile` | true | `gmail_get_profile` |
| `labels` | true | `gmail_list_labels` |
| `search` | true | `gmail_search_messages` |
| `readMessages` | true | `gmail_get_message` |
| `readThreads` | true | `gmail_get_thread` |
| `attachments` | true | `gmail_list_attachments`, `gmail_get_attachment`, `gmail_save_attachment`, `gmail_save_attachments` |
| `drafts` | false | `gmail_create_draft`, `gmail_list_drafts`, `gmail_send_draft` |
| `send` | false | `gmail_send_message` |
| `modify` | false | `gmail_modify_message_labels`, `gmail_trash_messages` |
| `labelsWrite` | false | `gmail_create_label` |
| `history` | false | `gmail_get_history` |

Two tools carry an additional gate beyond their feature flag: `gmail_save_attachment` and `gmail_save_attachments` also require `downloads.enabled` (§12.8/§12.9). Note that `gmail_create_label` is gated by `labelsWrite`, not `labels` — the `labels` flag only enables read access via `gmail_list_labels`.

### 9.4 Re-authentication

If the user changes scopes, the server must require re-authentication.

Provide:

```bash
gmail-mcp-server auth status
gmail-mcp-server auth login
gmail-mcp-server auth logout
gmail-mcp-server auth revoke
```

`logout` deletes local tokens. `revoke` should call Google token revocation when possible and then delete local tokens.

## 10. Configuration

Default config path:

```text
~/.gmail-mcp/config.json
```

Project-local override:

```text
./.gmail-mcp.json
```

Environment override prefix:

```text
GMAIL_MCP_
```

Environment variables override config keys using the `GMAIL_MCP_` prefix, uppercase names, and `_` as the nesting separator. Examples:

- `GMAIL_MCP_TRANSPORT=stdio` overrides `transport`.
- `GMAIL_MCP_LOGGING_LEVEL=debug` overrides `logging.level`.

`GMAIL_MCP_LIVE_TESTS=1` is a special test-only variable (see §22.3). Unlike the entries above it does not override a config key — it has no counterpart in the config schema and is read only by the test harness.

The `.env.example` file (required by §24) documents the supported variables.

Example config:

```json
{
  "activeProfile": "default",
  "transport": "stdio",
  "oauth": {
    "credentialsPath": "~/.gmail-mcp/credentials.json",
    "tokenPath": "~/.gmail-mcp/tokens/default.json",
    "scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
  },
  "features": {
    "profile": true,
    "labels": true,
    "labelsWrite": false,
    "search": true,
    "readMessages": true,
    "readThreads": true,
    "attachments": true,
    "drafts": false,
    "send": false,
    "modify": false,
    "history": false
  },
  "limits": {
    "defaultPageSize": 10,
    "maxPageSize": 100,
    "maxMessageBodyChars": 20000,
    "maxAttachmentBytes": 52428800,
    "maxBulkDownloadCount": 50,
    "toolResponseBodyCharLimit": 50000
  },
  "downloads": {
    "enabled": true,
    "rootDir": "~/Downloads/gmail-mcp",
    "preserveOriginalFilenames": true,
    "collisionPolicy": "append-counter",
    "allowedMimeTypes": [],
    "blockedExtensions": [".exe", ".dll", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".scr", ".com", ".jar", ".msi"],
    "includeInlineAttachmentsByDefault": false
  },
  "safety": {
    "requireConfirmationForSend": true,
    "requireConfirmationForModify": true,
    "requireConfirmationForBulkDownload": true,
    "bulkDownloadConfirmationThreshold": 10,
    "redactAccessTokensInLogs": true,
    "disableRawHtmlBodyByDefault": true,
    "allowRawMessage": false
  },
  "logging": {
    "level": "info",
    "auditLogPath": "~/.gmail-mcp/audit.jsonl"
  }
}
```

The `examples/` directory (§13.1, §24) ships four ready-to-use config variants covering four of the built-in scope profiles from §9.2 (readonly, modify, send, and full). Each uses the schema above and differs only in the `oauth.scopes` array and the matching `features` flags: `config.readonly.json` requests `gmail.readonly` with only read features enabled (the example above); `config.modify.json` adds `gmail.modify` plus the label/archive/trash features (`modify: true`, `labelsWrite: true`); `config.send.json` adds the `gmail.send` scope and enables `send: true`; and `config.full.json` uses `https://mail.google.com/` with all features enabled (discouraged unless required, per §24).

## 11. MCP Capability Design

The server should expose tools. Resources and prompts are optional but useful.

### 11.1 Tools

Tools perform actions or retrieve bounded data.

Naming convention:

```text
gmail_<verb>_<object>
```

All tools must return structured JSON-compatible objects.

The total serialized size of any tool response is bounded by `toolResponseBodyCharLimit`. Responses that would exceed it must be truncated and flagged (e.g. a `truncated: true` indicator), never silently cut.

All tools must include stable error objects following the canonical error shape defined in §17 (including the `retryable` field):

```json
{
  "ok": false,
  "error": {
    "code": "insufficient_scope",
    "message": "Tool requires gmail.readonly, gmail.modify, or mail.google.com scope.",
    "details": {
      "requiredAnyOf": ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"],
      "granted": ["..."]
    },
    "retryable": false
  }
}
```

### 11.2 Resources

Optional resources:

- `gmail://profile`
- `gmail://labels`
- `gmail://message/{messageId}`
- `gmail://thread/{threadId}`

Resources should be read-only and bounded.

### 11.3 Prompts

Optional prompts:

- `gmail-search-help`
- `gmail-safety-guidelines`
- `gmail-draft-reply`
- `gmail-attachment-workflow`

Prompts should not include private data.

## 12. Tool Specification

### 12.1 `gmail_get_profile`

Purpose: return the authenticated Gmail profile.

Required scopes: any of `gmail.metadata`, `gmail.readonly`, `gmail.modify`, or `mail.google.com` (the scopes Gmail's `users.getProfile` endpoint accepts). Profile retrieval may be unavailable when only `gmail.send` or `gmail.compose` is granted.

Input:

```json
{}
```

Output:

```json
{
  "ok": true,
  "profile": {
    "emailAddress": "user@example.com",
    "messagesTotal": 12345,
    "threadsTotal": 6789,
    "historyId": "123456"
  },
  "grantedScopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "enabledFeatures": ["search", "readMessages", "attachments"]
}
```

### 12.2 `gmail_list_labels`

Purpose: list Gmail labels.

Required scopes: `gmail.metadata`, `gmail.labels`, `gmail.readonly`, `gmail.modify`, or `mail.google.com` depending on Gmail API behavior. Implement based on official client behavior and tests.

Input:

```json
{
  "includeSystemLabels": true,
  "includeUserLabels": true
}
```

Output:

```json
{
  "ok": true,
  "labels": [
    {
      "id": "INBOX",
      "name": "INBOX",
      "type": "system",
      "messagesTotal": 100,
      "messagesUnread": 5,
      "threadsTotal": 80,
      "threadsUnread": 4
    }
  ]
}
```

### 12.3 `gmail_search_messages`

Purpose: search messages using Gmail query syntax.

Required scopes:

- `gmail.metadata` for metadata-only search where supported;
- `gmail.readonly`, `gmail.modify`, or `mail.google.com` for normal search/read flows.

Input:

```json
{
  "query": "has:attachment newer:2026/01/01 older:2026/02/01",
  "labelIds": ["INBOX"],
  "includeSpamTrash": false,
  "maxResults": 10,
  "pageToken": null,
  "format": "metadata"
}
```

Validation:

- `maxResults` must be between 1 and configured `maxPageSize`. When omitted, it defaults to `defaultPageSize`.
- `format` must be one of `id`, `summary`, or `metadata`; it controls how much is returned per message and defaults to `metadata` when omitted (this enum is specific to search and is distinct from the `gmail_get_message` `format` enum in §12.4):
  - `id`: only `id` and `threadId`.
  - `summary`: `id`, `threadId`, `labelIds`, `internalDate`, `snippet`, `hasAttachments`, and a reduced `headers` object containing only `from`, `subject`, and `date`.
  - `metadata`: all `summary` fields plus the `to` header (the shape shown in Output below).
- Never return full bodies from this tool.

Output (shown for `format: metadata`):

```json
{
  "ok": true,
  "messages": [
    {
      "id": "message-id",
      "threadId": "thread-id",
      "labelIds": ["INBOX"],
      "internalDate": "2026-06-01T09:15:00.000Z",
      "headers": {
        "from": "Sender <sender@example.com>",
        "to": "User <user@example.com>",
        "subject": "Subject",
        "date": "Mon, 1 Jun 2026 12:15:00 +0300"
      },
      "snippet": "Short Gmail snippet...",
      "hasAttachments": true
    }
  ],
  "nextPageToken": "..."
}
```

### 12.4 `gmail_get_message`

Purpose: return a single message with controlled body extraction.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "messageId": "message-id",
  "format": "parsed",
  "includeBody": true,
  "bodyFormat": "text",
  "maxBodyCharsPerMessage": 20000,
  "includeAttachmentMetadata": true,
  "includeRaw": false
}
```

Validation:

- `format` must be one of `metadata`, `parsed`, `full`, or `raw`; it defaults to `parsed` when omitted (this enum is specific to `gmail_get_message` and is distinct from the search `format` enum in §12.3):
  - `metadata`: headers, labels, and snippet only; no body or attachment bytes.
  - `parsed`: the parsed representation shown in Output below (headers, extracted body, attachment metadata).
  - `full`: same as `parsed` but also includes every MIME part's metadata.
  - `raw`: returns only the raw RFC822 message (in a `raw` field) instead of the parsed `body`; requires `safety.allowRawMessage` to be `true`.
- `includeBody` (default `true`): when `false`, the `body` object is returned as `null` even for `parsed`/`full` formats — useful when only headers and attachment metadata are needed.
- `includeRaw` adds the raw RFC822 message to the response (alongside `body`) when `format` is `parsed` or `full`; it has no effect when `format` is `metadata` or `raw`. Both `format: "raw"` and `includeRaw: true` require `safety.allowRawMessage` to be `true`, because raw RFC822 can be large and may include sensitive content; when it is `false`, such a call returns a `feature_disabled` error.
- `bodyFormat`: `text`, `html`, or `both`; defaults to `text` when omitted. The output `body` object always exposes `text`, `html`, and `truncated`: with `bodyFormat: "text"`, `html` is `null`; with `bodyFormat: "html"`, `text` is `null`; with `bodyFormat: "both"`, both are populated when available.
- `maxBodyCharsPerMessage` is a per-call input that is capped at the configured `maxMessageBodyChars` limit.
- `includeAttachmentMetadata` (default `true`): when `false`, the `attachments` array is omitted from the response.
- HTML body is disabled by default when `safety.disableRawHtmlBodyByDefault` is `true`; it is returned only when that flag is `false` or the call explicitly sets `bodyFormat` to `html`/`both` and safety allows it.

Output:

```json
{
  "ok": true,
  "message": {
    "id": "message-id",
    "threadId": "thread-id",
    "labelIds": ["INBOX"],
    "internalDate": "2026-06-01T09:15:00.000Z",
    "headers": {
      "from": "Sender <sender@example.com>",
      "to": "User <user@example.com>",
      "cc": null,
      "bcc": null,
      "subject": "Subject",
      "date": "Mon, 1 Jun 2026 12:15:00 +0300",
      "messageId": "<...>",
      "replyTo": null
    },
    "snippet": "...",
    "body": {
      "text": "Plain text body, truncated if needed",
      "html": null,
      "truncated": false
    },
    "attachments": [
      {
        "partId": "2",
        "attachmentId": "ANGjdJ...",
        "filename": "document.pdf",
        "mimeType": "application/pdf",
        "size": 123456,
        "disposition": "attachment",
        "inline": false
      }
    ]
  }
}
```

### 12.5 `gmail_get_thread`

Purpose: return a thread with bounded messages.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "threadId": "thread-id",
  "includeBodies": false,
  "bodyFormat": "text",
  "maxMessages": 20,
  "maxBodyCharsPerMessage": 10000,
  "includeAttachmentMetadata": true
}
```

Validation:

- Bodies are included only when `includeBodies` is true; when included, `bodyFormat` (`text`, `html`, or `both`; defaults to `text`) selects the body representation, following the same safety rules as `gmail_get_message` (§12.4).
- `maxMessages` defaults to `defaultPageSize` and is capped at `maxPageSize`.
- `maxBodyCharsPerMessage` is capped at `maxMessageBodyChars`.
- `includeAttachmentMetadata` (default `true`): when `false`, each message's `attachments` array is omitted.

Output:

```json
{
  "ok": true,
  "thread": {
    "id": "thread-id",
    "messages": [
      {
        "id": "message-id",
        "internalDate": "...",
        "headers": { "from": "...", "subject": "..." },
        "snippet": "...",
        "body": null,
        "attachments": []
      }
    ],
    "truncated": false
  }
}
```

### 12.6 `gmail_list_attachments`

Purpose: list attachments for a message without downloading bytes.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "messageId": "message-id",
  "includeInline": false
}
```

Validation:

- When `includeInline` is omitted, it defaults to `downloads.includeInlineAttachmentsByDefault`.
- `downloadAllowed` reports whether the attachment may be saved under the current download policy (§10 `downloads`, §15.2): it is `false` when the filename's extension is in `downloads.blockedExtensions`, when `downloads.allowedMimeTypes` is non-empty and the MIME type is not listed, or when the size exceeds `maxAttachmentBytes`.
- `blockedReason` is `null` when `downloadAllowed` is `true`; otherwise it is one of `file_blocked` (extension), `mime_type_blocked`, or `file_too_large` (matching the §17 error codes a save would return). Both fields are advisory metadata computed only by this tool.

Output:

```json
{
  "ok": true,
  "attachments": [
    {
      "messageId": "message-id",
      "partId": "2",
      "attachmentId": "ANGjdJ...",
      "filename": "file.pdf",
      "mimeType": "application/pdf",
      "size": 123456,
      "disposition": "attachment",
      "inline": false,
      "downloadAllowed": true,
      "blockedReason": null
    }
  ]
}
```

### 12.7 `gmail_get_attachment`

Purpose: retrieve attachment content as base64, only for small files or when explicitly enabled.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "messageId": "message-id",
  "attachmentId": "attachment-id",
  "partId": "2",
  "maxBytes": 1048576
}
```

Safety:

- Return a `file_too_large` error when the attachment size exceeds the per-call `maxBytes` or the configured `maxAttachmentBytes`, whichever is smaller. `maxBytes` is a per-call input (it is not a key in the §10 `limits` block) and defaults to a small value (e.g. 1 MiB) to discourage returning large blobs inline.
- Must obey `maxAttachmentBytes`.
- Should prefer `gmail_save_attachment` for normal usage.

Output:

```json
{
  "ok": true,
  "attachment": {
    "messageId": "message-id",
    "partId": "2",
    "attachmentId": "attachment-id",
    "filename": "file.pdf",
    "mimeType": "application/pdf",
    "size": 123456,
    "sha256": "...",
    "dataBase64": "..."
  }
}
```

### 12.8 `gmail_save_attachment`

Purpose: save attachment bytes to local filesystem under configured download root.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "messageId": "message-id",
  "attachmentId": "attachment-id",
  "partId": "2",
  "targetDirectory": "2026/06",
  "filename": "optional-safe-name.pdf",
  "overwrite": false
}
```

Validation:

- Disabled unless both `features.attachments` and `downloads.enabled` are true; return `feature_disabled` when either is false.
- `targetDirectory` must be relative.
- Reject absolute paths.
- Reject paths containing `..` after normalization.
- Final resolved path must be inside `downloads.rootDir`.
- Sanitize filename.
- Apply blocked extension policy.
- Apply MIME allowlist if configured.
- Apply size limit.

Output:

```json
{
  "ok": true,
  "savedAttachment": {
    "path": "/home/user/Downloads/gmail-mcp/2026/06/file.pdf",
    "filename": "file.pdf",
    "mimeType": "application/pdf",
    "size": 123456,
    "sha256": "...",
    "collisionPolicyApplied": "append-counter"
  }
}
```

### 12.9 `gmail_save_attachments`

Purpose: save multiple attachments from one or more messages.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`.

Input:

```json
{
  "items": [
    {
      "messageId": "message-id",
      "attachmentId": "attachment-id",
      "partId": "2",
      "targetDirectory": "batch",
      "filename": null
    }
  ],
  "overwrite": false
}
```

Safety:

- Disabled unless both `features.attachments` and `downloads.enabled` are true; return `feature_disabled` when either is false.
- When `requireConfirmationForBulkDownload` is enabled and the item count exceeds `bulkDownloadConfirmationThreshold`, require confirmation if MCP elicitation is available or return a `confirmation_required` error.
- If item count exceeds `maxBulkDownloadCount`, reject the call with an `invalid_input` error before downloading anything. This is a hard cap, distinct from the confirmation threshold.
- Each item is subject to the same path, filename, blocked-extension, MIME-allowlist, and size validation as `gmail_save_attachment` (§12.8); an item that fails validation is reported in `failed` without aborting the others.
- Never silently download hundreds of attachments.

Output:

```json
{
  "ok": true,
  "saved": [
    {
      "messageId": "message-id",
      "attachmentId": "attachment-id",
      "partId": "2",
      "path": "/home/user/Downloads/gmail-mcp/batch/file.pdf",
      "filename": "file.pdf",
      "mimeType": "application/pdf",
      "size": 123456,
      "sha256": "...",
      "collisionPolicyApplied": "append-counter"
    }
  ],
  "skipped": [
    {
      "messageId": "message-id",
      "attachmentId": "other-attachment-id",
      "partId": "3",
      "reason": "duplicate"
    }
  ],
  "failed": [
    {
      "messageId": "message-id",
      "attachmentId": "blocked-attachment-id",
      "partId": "4",
      "error": {
        "code": "file_blocked",
        "message": "Extension .exe is blocked.",
        "retryable": false
      }
    }
  ]
}
```

Each result array entry carries the item's `messageId`, `attachmentId`, and `partId` for correlation:

- `saved`: entries mirror the `savedAttachment` object from `gmail_save_attachment` (§12.8).
- `skipped`: entries for items deliberately not written — for example, when an identical file already exists under the `content-addressed` collision policy (§15.3) — each with a `reason`.
- `failed`: entries for items that errored during validation or download, each with the canonical §17 `error` object (the `fail` collision policy on an existing file surfaces here, not in `skipped`).

### 12.10 `gmail_create_draft`

Purpose: create a Gmail draft.

Required scopes: `gmail.compose`, `gmail.modify`, or `mail.google.com`, depending on Gmail API requirements.

Input:

```json
{
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Subject",
  "bodyText": "Hello",
  "bodyHtml": null,
  "replyToMessageId": null,
  "attachmentsFromLocalPaths": []
}
```

Safety:

- Disabled unless `features.drafts` is true (off by default), consistent with the other draft tools. Creating a draft is safer than sending, but still writes to mailbox.
- `attachmentsFromLocalPaths` is reserved and must be empty in v1; outbound attachment uploads are deferred (see §3 Non-Goals). When uploads are introduced in a future version, local attachment paths must be inside explicitly allowed upload roots.

Output:

```json
{
  "ok": true,
  "draft": {
    "id": "draft-id",
    "messageId": "message-id",
    "threadId": "thread-id"
  }
}
```

### 12.11 `gmail_list_drafts`

Purpose: list draft summaries.

Required scopes: `gmail.compose`, `gmail.modify`, or `mail.google.com`, depending on Gmail API requirements.

Safety:

- Disabled unless `features.drafts` is true (off by default), consistent with the other draft tools.

Input:

```json
{
  "maxResults": 10,
  "pageToken": null
}
```

Validation:

- `maxResults` defaults to `defaultPageSize` and is capped at `maxPageSize`.
- `pageToken` is passed through to Gmail for pagination.

Output:

```json
{
  "ok": true,
  "drafts": [
    {
      "id": "draft-id",
      "message": {
        "id": "message-id",
        "threadId": "thread-id",
        "headers": { "to": "...", "subject": "..." },
        "snippet": "..."
      }
    }
  ],
  "nextPageToken": null
}
```

### 12.12 `gmail_send_draft`

Purpose: send an existing draft.

Required scopes: `gmail.compose`, `gmail.modify`, or `mail.google.com`, depending on Gmail API requirements.

Input:

```json
{
  "draftId": "draft-id",
  "confirmation": "I understand this will send an email"
}
```

Safety:

- Disabled unless `features.drafts` is true (off by default), consistent with the other draft tools.
- Require confirmation when `requireConfirmationForSend` is true (default).
- If MCP elicitation is supported, ask user interactively.
- Otherwise require exact confirmation string.

Output:

```json
{
  "ok": true,
  "sentMessage": {
    "id": "message-id",
    "threadId": "thread-id"
  }
}
```

### 12.13 `gmail_send_message`

Purpose: send a new message directly.

Required scopes: `gmail.send` or `mail.google.com`.

Input:

```json
{
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Subject",
  "bodyText": "Hello",
  "bodyHtml": null,
  "attachmentsFromLocalPaths": [],
  "confirmation": "I understand this will send an email"
}
```

Safety:

- Disabled unless `features.send` is true (off by default).
- `attachmentsFromLocalPaths` is reserved and must be empty in v1; outbound attachment uploads are deferred (see §3 Non-Goals).
- Require confirmation when `requireConfirmationForSend` is true (default).
- If MCP elicitation is supported, ask user interactively.
- Otherwise require exact confirmation string.
- Must log send metadata to audit log, but never log full body unless debug explicitly allows it.

Output:

```json
{
  "ok": true,
  "sentMessage": {
    "id": "message-id",
    "threadId": "thread-id"
  }
}
```

### 12.14 `gmail_modify_message_labels`

Purpose: add/remove labels on messages.

Required scopes: `gmail.modify` or `mail.google.com`.

Input:

```json
{
  "messageIds": ["message-id"],
  "addLabelIds": ["Label_123"],
  "removeLabelIds": ["INBOX"]
}
```

Safety:

- Disabled unless `features.modify` is true (off by default).
- Require confirmation when `requireConfirmationForModify` is true (default) or when operating on multiple messages.

Output:

```json
{
  "ok": true,
  "modified": ["message-id"],
  "failed": []
}
```

### 12.15 `gmail_trash_messages`

Purpose: move messages to Trash.

Required scopes: `gmail.modify` or `mail.google.com`.

Input:

```json
{
  "messageIds": ["message-id"],
  "confirmation": "I understand this will move messages to Trash"
}
```

Safety:

- Disabled unless `features.modify` is true (off by default).
- Always require confirmation, regardless of `requireConfirmationForModify`. If MCP elicitation is supported, ask the user interactively; otherwise require the exact `confirmation` string shown above.
- Do not implement permanent delete in v1.

Output:

```json
{
  "ok": true,
  "trashed": ["message-id"],
  "failed": []
}
```

### 12.16 `gmail_create_label`

Purpose: create Gmail labels.

Required scopes: `gmail.labels`, `gmail.modify`, or `mail.google.com`.

Safety:

- Disabled unless `features.labelsWrite` is true (off by default). The `features.labels` flag only enables read access via `gmail_list_labels`.

Input:

```json
{
  "name": "Projects/Example",
  "labelListVisibility": "labelShow",
  "messageListVisibility": "show"
}
```

Output:

```json
{
  "ok": true,
  "label": {
    "id": "Label_123",
    "name": "Projects/Example"
  }
}
```

### 12.17 `gmail_get_history`

Purpose: get mailbox changes since a history ID.

Required scopes: `gmail.readonly`, `gmail.modify`, or `mail.google.com`, depending on Gmail API behavior.

Safety:

- Disabled unless `features.history` is true (off by default).

Input:

```json
{
  "startHistoryId": "123456",
  "historyTypes": ["messageAdded", "labelAdded"],
  "labelId": null,
  "maxResults": 10,
  "pageToken": null
}
```

Validation:

- `maxResults` defaults to `defaultPageSize` and is capped at `maxPageSize`.
- `pageToken` is passed through to Gmail for pagination.

Output:

```json
{
  "ok": true,
  "history": [],
  "nextPageToken": null,
  "historyId": "123999"
}
```

## 13. Internal Architecture

### 13.1 Modules

```text
gmail-mcp-server/
  README.md
  LICENSE
  SECURITY.md
  CONTRIBUTING.md
  package.json
  tsconfig.json
  .env.example
  docs/
    hld/
      GMAIL_MCP_SERVER_HLD.md
  src/
    index.ts
    cli.ts
    mcp/
      server.ts
      transport.ts
      toolRegistry.ts
      errors.ts
    config/
      config.ts
      configSchema.ts
      loadConfig.ts
      paths.ts
    auth/
      oauthClient.ts
      tokenStore.ts
      scopeProfiles.ts
      scopeGate.ts
      authCommands.ts
    gmail/
      gmailClient.ts
      profile.ts
      labels.ts
      search.ts
      messages.ts
      threads.ts
      drafts.ts
      send.ts
      modify.ts
      history.ts
    mime/
      parseMessage.ts
      headers.ts
      bodyExtractor.ts
      attachmentExtractor.ts
      base64url.ts
      rfc822.ts
    attachments/
      attachmentService.ts
      downloadPolicy.ts
      saveAttachment.ts
      filenamePolicy.ts
      pathGuard.ts
      hash.ts
    safety/
      confirmation.ts
      limits.ts
      redaction.ts
      promptInjectionNotes.ts
    audit/
      auditLogger.ts
      auditEvents.ts
    tools/
      gmailGetProfile.ts
      gmailListLabels.ts
      gmailSearchMessages.ts
      gmailGetMessage.ts
      gmailGetThread.ts
      gmailListAttachments.ts
      gmailGetAttachment.ts
      gmailSaveAttachment.ts
      gmailSaveAttachments.ts
      gmailCreateDraft.ts
      gmailListDrafts.ts
      gmailSendDraft.ts
      gmailSendMessage.ts
      gmailModifyMessageLabels.ts
      gmailTrashMessages.ts
      gmailCreateLabel.ts
      gmailGetHistory.ts
    util/
      result.ts
      async.ts
      pagination.ts
      date.ts
      size.ts
  test/
    unit/
      mime/
      attachments/
      auth/
      tools/
    integration/
      gmailClient.fake.test.ts
      mcpServer.test.ts
  examples/
    config.readonly.json
    config.modify.json
    config.send.json
    config.full.json
    claude-code.mcp.json
```

### 13.2 Dependency direction

Allowed:

- `tools` -> `gmail`, `auth`, `safety`, `audit`, `attachments`
- `gmail` -> Google API client
- `attachments` -> `mime`, `config`, filesystem
- `mcp` -> `tools`

Forbidden:

- `gmail` importing MCP SDK
- `auth` importing tools
- business logic inside MCP registration callbacks

### 13.3 Result type

Use a consistent result shape internally:

```ts
type AppResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };
```

Tools may convert this to MCP-friendly JSON.

## 14. MIME Parsing Requirements

Implement a recursive parser for Gmail `MessagePart` trees.

Requirements:

1. Preserve key headers case-insensitively.
2. Extract plain text body from `text/plain` parts.
3. Extract HTML body from `text/html` parts only when requested.
4. Treat parts with non-empty filename as attachments, even if disposition is missing.
5. Treat `Content-Disposition: inline` parts as inline attachments.
6. Respect `includeInline` option.
7. Handle nested multipart structures:
   - `multipart/alternative`
   - `multipart/mixed`
   - `multipart/related`
   - `message/rfc822`
8. Decode base64url safely.
9. Do not crash on malformed parts; return warnings.

Attachment descriptor:

```ts
interface GmailAttachmentDescriptor {
  messageId: string;
  partId?: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: 'attachment' | 'inline' | 'unknown';
  inline: boolean;
  contentId?: string;
  headers: Record<string, string>;
  source: 'external-attachment' | 'inline-body-data';
}
```

`GmailAttachmentDescriptor` is the parser's internal representation. Tool responses expose a subset of these fields: `gmail_list_attachments` (§12.6) returns `messageId`, `partId`, `attachmentId`, `filename`, `mimeType`, `size`, `disposition`, and `inline`, plus the advisory policy fields `downloadAllowed` and `blockedReason` (computed from the download policy, not part of the descriptor); the per-message `attachments` array in `gmail_get_message` (§12.4) returns the descriptor fields minus `messageId` (the message context is implicit) and without the policy fields. The `contentId`, `headers`, and `source` fields are internal-only and are not included in tool output JSON.

## 15. Filesystem Safety

### 15.1 Download root

All saved files must stay under configured `downloads.rootDir`.

Algorithm:

1. Expand `~`.
2. Resolve root to absolute path.
3. Resolve requested relative path against root.
4. Normalize.
5. Check that final path starts with root path plus path separator or equals root.
6. Reject otherwise.

### 15.2 Filenames

Filename policy:

1. When `downloads.preserveOriginalFilenames` is true (default), use the original filename if present and allowed; when false, always generate the name in step 2.
2. Generate `gmail-attachment-{messageId}-{partId}` whenever the original filename is not used (per step 1).
3. Sanitize control characters and reserved filesystem characters.
4. Trim to a safe length, for example 180 characters before extension.
5. Preserve extension when safe.
6. Apply blocked extension policy.
7. If extension does not match MIME type, do not fail automatically, but include warning unless blocked.

### 15.3 Collision policy

Supported values:

- `append-counter`: `file.pdf`, `file (1).pdf`, `file (2).pdf`
- `overwrite`: only if explicitly allowed
- `fail`: return error if file exists
- `content-addressed`: save as `{sha256}.{ext}`

Default: `append-counter`.

## 16. Safety and Security Requirements

### 16.1 Prompt injection model

Email content is untrusted input. It may contain instructions aimed at the model.

The server must not execute instructions from email content. It only returns data. Tool descriptions should warn the client that message bodies are untrusted.

### 16.2 No raw API passthrough

Do not implement:

```text
gmail_raw_request
run_gmail_api
execute_google_api
```

### 16.3 Write operation controls

For send, trash, modify, label changes, and bulk actions:

1. Feature flag must enable the category.
2. OAuth scope must permit it.
3. Destructive or outbound actions require confirmation: sending a message or draft requires confirmation when `requireConfirmationForSend` is enabled (default), and trashing always requires confirmation. Reversible message modifications (label add/remove) require confirmation when `requireConfirmationForModify` is enabled or when operating on multiple messages. When MCP elicitation is unavailable, confirmation is supplied through each tool's `confirmation` input, which is tool-specific and must match the documented string exactly (case-sensitive).
4. Audit log must record the action.

### 16.4 Token safety

1. Never return tokens through MCP tools.
2. Never log access tokens or refresh tokens. As defense in depth, `safety.redactAccessTokensInLogs` (default `true`) scrubs any token-shaped values that leak into third-party HTTP or debug output; it is not a switch for enabling deliberate token logging, which is prohibited regardless of its value.
3. Store tokens with restrictive filesystem permissions where possible.
4. Print a warning if token file permissions look too permissive.
5. Support token revocation.

### 16.5 Logging safety

Default logs must not include full message bodies or attachment bytes.

Audit logs may include:

- timestamp
- tool name
- Gmail profile email
- message IDs
- thread IDs
- subject
- sender
- filenames
- local paths
- sha256
- size
- result status

Audit logs must not include:

- OAuth tokens
- full message bodies
- attachment bytes
- full raw MIME

## 17. Error Model

Standard error codes:

```text
invalid_input
not_authenticated
insufficient_scope
feature_disabled
gmail_api_error
rate_limited
not_found
permission_denied
confirmation_required
path_not_allowed
file_blocked
file_too_large
mime_type_blocked
decode_failed
network_error
internal_error
```

Error shape:

```json
{
  "ok": false,
  "error": {
    "code": "file_too_large",
    "message": "Attachment exceeds configured maxAttachmentBytes.",
    "details": {
      "size": 104857600,
      "maxAttachmentBytes": 52428800
    },
    "retryable": false
  }
}
```

## 18. Pagination

All list/search tools must support `pageToken` and `maxResults` where Gmail supports it. Unless otherwise noted, `maxResults` defaults to `defaultPageSize` and is capped at `maxPageSize`. (Gmail's `users.labels.list` returns the full label set in a single response and takes no `pageToken`/`maxResults`, so `gmail_list_labels` (§12.2) intentionally exposes no pagination inputs.)

Never auto-page through an unbounded mailbox in one tool call.

For batch workflows, require explicit page tokens or explicit bounded limits.

## 19. Rate Limiting and Retries

Implement retries for transient failures:

- HTTP 429
- HTTP 500
- HTTP 502
- HTTP 503
- HTTP 504
- network timeouts

Use exponential backoff with jitter.

Do not retry non-idempotent sends unless Gmail API behavior makes it safe. Prefer creating drafts first.

## 20. CLI Commands

Required CLI:

```bash
gmail-mcp-server --help
gmail-mcp-server auth login
gmail-mcp-server auth status
gmail-mcp-server auth logout
gmail-mcp-server auth revoke
gmail-mcp-server config init
gmail-mcp-server config show
gmail-mcp-server doctor
gmail-mcp-server start
```

`doctor` should check:

1. Node version.
2. Config validity.
3. Credentials file exists.
4. Token file exists or auth needed.
5. Token scopes.
6. Download root exists/writable if downloads enabled.
7. Feature flags match granted scopes.

## 21. Claude Code Setup Documentation

Provide in README:

### 21.1 Local stdio

```bash
npm install -g gmail-mcp-server
gmail-mcp-server config init
gmail-mcp-server auth login --scope-profile readonly
claude mcp add gmail -- gmail-mcp-server start --transport stdio
```

### 21.2 Project config example

This is the content of `examples/claude-code.mcp.json`. Place it at your project root as `.mcp.json`:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "gmail-mcp-server",
      "args": ["start", "--transport", "stdio"]
    }
  }
}
```

## 22. Testing Strategy

### 22.1 Unit tests

Required:

1. Scope profile expansion.
2. Scope gate logic.
3. Config loading and env overrides.
4. Header parsing.
5. MIME tree parsing.
6. Plain text extraction.
7. HTML extraction disabled by default.
8. Attachment discovery from `body.attachmentId`.
9. Attachment discovery from inline `body.data`.
10. Base64url decoding.
11. Filename sanitization.
12. Path traversal rejection.
13. Collision policy.
14. Blocked extension policy.
15. MIME allowlist policy.
16. Audit redaction.
17. Pagination clamping: `maxResults` defaults to `defaultPageSize` and is capped at `maxPageSize`; `pageToken` passthrough.
18. Response truncation: oversized responses are flagged with `truncated: true` and bounded by `toolResponseBodyCharLimit`.
19. Body cap: `maxBodyCharsPerMessage` is capped at `maxMessageBodyChars`.

### 22.2 Integration tests without real Gmail

Use fake Gmail API client fixtures.

Fixtures:

1. Simple plain text email.
2. Multipart alternative text/html.
3. PDF attachment.
4. Inline image.
5. Nested `message/rfc822`.
6. Malformed base64.
7. Missing filename.
8. Huge attachment metadata.
9. Gmail API 429 retry.
10. Insufficient scope.

### 22.3 Optional live tests

Live tests must be opt-in via environment variable:

```bash
GMAIL_MCP_LIVE_TESTS=1 npm test
```

Never run live tests in CI by default.

## 23. CI/CD

GitHub Actions:

1. Install.
2. Typecheck.
3. Lint.
4. Unit tests.
5. Build.
6. Package smoke test.
7. Secret scanning if available.

No real Gmail credentials in CI.

## 24. Public Repository Requirements

Files:

```text
README.md
docs/hld/GMAIL_MCP_SERVER_HLD.md
SECURITY.md
CONTRIBUTING.md
LICENSE
.env.example
examples/config.readonly.json
examples/config.modify.json
examples/config.send.json
examples/config.full.json
examples/claude-code.mcp.json
```

README must clearly say:

1. This is not an official Google product.
2. This is not an official Anthropic product.
3. Users should grant the narrowest Gmail scopes they need.
4. `https://mail.google.com/` is very broad and should be avoided unless necessary.
5. Email content is untrusted and may contain prompt injection.
6. Users should review write/send actions before enabling them.

## 25. Versioning

Use semantic versioning.

Initial versions:

- `0.1.0`: readonly search/read/attachments local stdio
- `0.2.0`: labels and modify tools
- `0.3.0`: drafts and send tools
- `0.4.0`: optional HTTP transport
- `1.0.0`: stable public API and security review complete

## 26. Implementation Milestones

### 26.1 Milestone 1 — Project skeleton

Deliver:

- TypeScript project
- MCP stdio server starts
- Config loading
- Structured errors
- Basic logging
- Tests framework

Acceptance:

- `npm run build` passes
- `npm test` passes
- Claude Code can list one dummy health tool

### 26.2 Milestone 2 — OAuth

Deliver:

- OAuth desktop flow
- Token storage
- Auth CLI
- Scope profiles
- Scope gate

Acceptance:

- `auth login --scope-profile readonly` works
- `auth status` shows email and granted scopes
- token is not printed in logs

### 26.3 Milestone 3 — Read-only Gmail

Deliver:

- profile
- labels
- search messages
- get message
- get thread
- MIME parser

Acceptance:

- Can search Gmail and read a bounded message body
- Tool outputs do not exceed configured limits

### 26.4 Milestone 4 — Attachments

Deliver:

- list attachments
- get small attachment as base64
- save attachment to local root
- save multiple attachments
- path/filename safety
- audit log

Acceptance:

- Can save PDF attachment
- Path traversal tests pass
- Blocked extension tests pass
- Bulk download confirmation works

### 26.5 Milestone 5 — Write features

Deliver:

- drafts
- send draft
- send message
- modify labels
- trash messages
- create label

Acceptance:

- Tools are hidden or rejected without scopes
- Write tools require confirmation
- Audit log records write actions

### 26.6 Milestone 6 — Polish for public release

Deliver:

- README
- SECURITY.md
- examples
- CI
- package publishing setup
- threat model documentation

Acceptance:

- Fresh user can install and configure from README
- `doctor` explains missing setup steps
- No secrets in repo

## 27. Coding Guidelines for Claude Code

When implementing this project:

1. Do not put business logic directly in MCP tool registration functions.
2. Write tests for each module before or alongside implementation.
3. Keep every tool bounded by limits from config.
4. Never add a raw Gmail API passthrough tool.
5. Never log OAuth tokens.
6. Never save files outside configured download root.
7. Prefer draft creation over direct sending in examples.
8. Treat all email body content as untrusted data.
9. Use typed schemas for all tool inputs.
10. Use stable, explicit error codes.
11. Keep functions small and testable.
12. Update README and examples whenever a tool is added.

## 28. Definition of Done

The project is done when:

1. A user can install the package locally.
2. A user can configure Gmail OAuth credentials.
3. A user can choose scopes.
4. Claude Code can connect to the MCP server over stdio.
5. Claude Code can search Gmail messages.
6. Claude Code can read message summaries and bodies within configured limits.
7. Claude Code can list and save Gmail attachments.
8. Write/send/modify tools are available only when enabled and scoped.
9. Dangerous writes and sends require confirmation.
10. Path traversal and unsafe file tests pass.
11. The repository has README, SECURITY, examples, and CI.
12. The codebase is suitable for public review.

## 29. Suggested First Prompt for Claude Code

Use this prompt after placing this file in the repository as `docs/hld/GMAIL_MCP_SERVER_HLD.md`:

```text
You are implementing the Gmail MCP Server described in docs/hld/GMAIL_MCP_SERVER_HLD.md.

Start with Milestone 1 and Milestone 2 only. Do not implement Gmail tools yet except a dummy health tool.

Requirements:
- TypeScript project.
- MCP stdio server.
- Config loading with Zod validation.
- OAuth scope profile definitions.
- Token store abstraction.
- CLI with config init, auth status, doctor, start.
- Unit tests for config and scope gates.
- No raw Gmail API passthrough.
- Do not hardcode invoice-specific behavior.

After each meaningful step, update a PROGRESS.md file with current status, completed files, next tasks, and known issues.
```

Note: `PROGRESS.md` referenced above is a transient implementation working file maintained by the coding agent. It is intentionally not part of the module tree in §13.1 or the published-repository file set in §24, and should be git-ignored.
