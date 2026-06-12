# Gmail MCP Server — Implementation Guide (Step-by-Step)

> Purpose: this is the **execution plan** for building the server specified in
> [`GMAIL_MCP_SERVER_HLD.md`](./GMAIL_MCP_SERVER_HLD.md). The HLD is the source of
> truth for *what* to build; this document is the ordered, small-step recipe for
> *how* to build it, with an explicit, verifiable success gate for every step.
>
> Hand this file to a coding agent alongside the HLD. Work **top to bottom**: do
> not start a step until its dependencies are green. Every "§x" reference points
> to a section of the HLD.

---

## How to use this document

- Each step is sized to be completed and verified in isolation (roughly one
  cohesive unit: a module + its tests, or a single tool).
- A step is **not done** until *all* of its success criteria pass — not "the code
  is written," but "the criteria are observably met."
- After finishing a step, update `PROGRESS.md` (see below) and only then move on.
- If a step reveals a gap or contradiction in the HLD, **stop and report it**
  rather than improvising; the HLD has been consistency-checked and should be
  treated as authoritative.

### Verification commands (the canonical toolbox)

These are referenced throughout as the building blocks of success criteria:

| Command | Meaning |
|---|---|
| `npm run build` | TypeScript compiles with no errors (`tsc --noEmit` or emit to `dist/`). |
| `npm run typecheck` | `tsc --noEmit` passes (may be folded into `build`). |
| `npm run lint` | ESLint passes with zero errors. |
| `npm run format:check` | Prettier reports no formatting drift. |
| `npm test` | Full Vitest suite passes. |
| `npm test -- <path>` | Runs one test file/folder (used in per-step criteria). |
| `node ./dist/index.js <args>` | Runs the built CLI/server. |

Live Gmail steps are validated separately and **opt-in only**:
`GMAIL_MCP_LIVE_TESTS=1 npm test` (§22.3). Never required for a step to pass in CI.

### Universal "Definition of Step Done"

Every step must satisfy these in addition to its own criteria:

1. `npm run build`, `npm run lint`, and `npm test` are all green.
2. New code has unit tests in the matching `test/unit/<area>/` folder (§13.1).
3. No business logic lives inside MCP registration callbacks (§13.2, §27.1).
4. The dependency-direction rules in §13.2 are respected (no forbidden imports).
5. Typed schemas (Zod) guard every external/tool input (§27.9).
6. Stable, explicit error codes from §17 are used — no ad-hoc error strings (§27.10).
7. No OAuth token is ever logged or returned through a tool (§16.4, §27.5).
8. `PROGRESS.md` is updated (status, files touched, next step, known issues).

### Architecture invariants (hold for the whole project)

- Module tree and file names match §13.1 exactly.
- Allowed dependency edges only (§13.2): `tools → gmail/auth/safety/audit/attachments`,
  `attachments → mime/config/fs`, `mcp → tools`, `gmail → Google client`.
- Forbidden: `gmail` importing the MCP SDK; `auth` importing `tools`; business
  logic in MCP callbacks (§13.2).
- No raw Gmail passthrough tool, ever (§16.2, §27.4).
- Every tool returns the canonical result/error shape from §11.1 / §17.
- Every tool is bounded by config limits (§10 `limits`, §27.3).

### PROGRESS.md (transient working file)

Maintain a `PROGRESS.md` at repo root with: current step, completed files, next
tasks, known issues (§29 note). It is **git-ignored** and is intentionally *not*
part of the module tree (§13.1) or the published file set (§24).

---

## Roadmap at a glance

Steps are grouped into phases that map 1:1 onto the HLD milestones (§26) and the
release versions (§25):

| Phase | HLD Milestone | Target version | Theme |
|---|---|---|---|
| 0 | M1 (§26.1) | — | Repository bootstrap |
| 1 | M1 (§26.1) | — | Foundations: errors, config, logging |
| 2 | M1 (§26.1) | — | MCP stdio skeleton + CLI + health tool |
| 3 | M2 (§26.2) | — | OAuth, scopes, token store |
| 4 | M3 (§26.3) | `0.1.0` (read core) | MIME parser + read-only tools |
| 5 | M4 (§26.4) | `0.1.0` | Attachments + filesystem safety + audit |
| 6 | M5 (§26.5) | `0.2.0` / `0.3.0` | Write tools (labels, modify, drafts, send, history) |
| 7 | M6 (§26.6) | `0.4.0` / `1.0.0` | Optional HTTP, resources/prompts, docs, CI, release |

Each phase ends with a **Milestone Gate** that restates the HLD acceptance
criteria. Do not advance phases until the gate passes.

---

## Phase 0 — Repository bootstrap (Milestone 1)

### Step 0.1 — Project scaffolding

**Goal:** an empty but buildable, lintable, testable TypeScript project with the
directory skeleton from §13.1.

**Files:** `package.json`, `tsconfig.json`, `.eslintrc`, `.prettierrc`,
`vitest.config.ts`, `.gitignore` (include `PROGRESS.md`, `dist/`, `node_modules/`,
`~/.gmail-mcp` is outside repo so n/a), plus empty `src/` and `test/` trees
matching §13.1.

**Implement:**
- Dependencies and devDependencies from §7 (pin the **stable** MCP SDK track, §7 note).
- `bin` entry mapping `gmail-mcp-server` → `dist/index.js`.
- npm scripts for every verification command above.

**Success criteria:**
- [ ] `npm install` succeeds.
- [ ] `npm run build` succeeds (compiles an empty/stub `src/index.ts`).
- [ ] `npm run lint` and `npm run format:check` pass.
- [ ] `npm test` runs and reports **0 tests, 0 failures** (Vitest wired up).
- [ ] Directory layout matches §13.1 (folders may contain `.gitkeep`).

**HLD refs:** §7, §13.1, §26.1.

### Step 0.2 — Core result & async utilities

**Goal:** the internal `AppResult<T>` type and small shared helpers everything builds on.

**Files:** `src/util/result.ts`, `src/util/async.ts`, `src/util/size.ts`,
`src/util/date.ts`, `src/util/pagination.ts` (skeletons; fill as needed later).

**Implement:**
- `AppResult<T>` discriminated union exactly as §13.3 (`{ok:true,value}` /
  `{ok:false,error}`), plus `ok()`/`err()` constructors.
- `AppError` interface shaped to §17 (`code`, `message`, `details?`, `retryable`).

**Success criteria:**
- [ ] `test/unit/util/result.test.ts` covers `ok`/`err` construction and narrowing.
- [ ] `AppError.code` is typed to the §17 code union (compile-time enforced).
- [ ] Universal Definition of Step Done met.

**HLD refs:** §13.3, §17.

---

## Phase 1 — Foundations: errors, config, logging (Milestone 1)

### Step 1.1 — Error model

**Goal:** one place that defines all error codes and the canonical error object.

**Files:** `src/mcp/errors.ts`.

**Implement:**
- A `const`/enum listing **all 16** error codes from §17 verbatim.
- A factory that produces the §17 error shape incl. the `retryable` field.
- Helpers to map common failures (e.g. Gmail 429 → `rate_limited` retryable).

**Success criteria:**
- [ ] `test/unit/.../errors.test.ts`: every §17 code is representable; a sample
      error serializes to the exact shape in §17 (incl. `retryable`).
- [ ] `insufficient_scope` error matches the §11.1 example (with `requiredAnyOf`/`granted`).
- [ ] No code path throws raw strings; all go through the factory.

**HLD refs:** §11.1, §17.

### Step 1.2 — Config schema

**Goal:** a Zod schema that exactly models the §10 config object.

**Files:** `src/config/configSchema.ts`, `src/config/config.ts` (types).

**Implement:**
- Zod schema with the **11 feature flags** (`profile, labels, labelsWrite, search,
  readMessages, readThreads, attachments, drafts, send, modify, history`) and the
  defaults from §9.3 (read-oriented `true`, write/optional `false`).
- `limits`, `downloads`, `safety`, `logging`, `oauth`, `transport`, `activeProfile`
  blocks with the exact keys and defaults from the §10 example.

**Success criteria:**
- [ ] `test/unit/.../configSchema.test.ts`: the literal §10 example config parses
      successfully and round-trips.
- [ ] Defaults applied to an empty `{}` match §9.3 (e.g. `drafts:false`, `search:true`).
- [ ] Invalid values (unknown feature key, negative `maxPageSize`, non-enum
      `collisionPolicy`) are rejected with `invalid_input`.

**HLD refs:** §9.3, §10, §15.3.

### Step 1.3 — Config loading, path expansion, env overrides

**Goal:** resolve effective config from defaults → file → project-local → env.

**Files:** `src/config/loadConfig.ts`, `src/config/paths.ts`.

**Implement:**
- Load order/precedence: `~/.gmail-mcp/config.json` → `./.gmail-mcp.json` → env
  (§10). Env keys use `GMAIL_MCP_` prefix, uppercase, `_` nesting separator (§10).
- `~` expansion for all path-valued keys (§15.1 step 1).
- `GMAIL_MCP_LIVE_TESTS` is **not** a config key — must be ignored by the loader (§10).

**Success criteria:**
- [ ] Tests: `GMAIL_MCP_TRANSPORT=stdio` overrides `transport`;
      `GMAIL_MCP_LOGGING_LEVEL=debug` overrides `logging.level` (§10 examples).
- [ ] Test: project-local `./.gmail-mcp.json` overrides the home config.
- [ ] Test: `~` expands to the home dir for `credentialsPath`/`tokenPath`/`rootDir`.
- [ ] Test: `GMAIL_MCP_LIVE_TESTS=1` does **not** appear in or mutate effective config.

**HLD refs:** §10, §15.1, §22.1 (#3).

### Step 1.4 — Logging + token redaction

**Goal:** structured logging that can never leak tokens.

**Files:** `src/safety/redaction.ts`, logger setup (pino) in a small util.

**Implement:**
- pino logger honoring `logging.level`.
- `redactAccessTokensInLogs` (default true) scrubs token-shaped values from any
  third-party/debug output (§16.4 item 2) — defense in depth, **not** a switch to
  enable token logging (which is always prohibited).

**Success criteria:**
- [ ] `test/unit/.../redaction.test.ts`: token-shaped strings (e.g. `ya29.…`,
      refresh tokens) are replaced in sample log records (§22.1 #16 supports this).
- [ ] No log path can emit a full access/refresh token regardless of flag value.

**HLD refs:** §16.4, §16.5, §22.1 (#16).

**Note:** the full audit logger is built in Step 5.10; this step is only the
base logger + redaction primitive.

---

## Phase 2 — MCP skeleton + CLI + health tool (Milestone 1)

### Step 2.1 — Thin MCP SDK layer + stdio transport

**Goal:** start an MCP server over stdio behind a thin abstraction (§7 note, §13.2).

**Files:** `src/mcp/server.ts`, `src/mcp/transport.ts`, `src/mcp/toolRegistry.ts`.

**Implement:**
- A `ToolRegistry` that holds tool definitions (name, input schema, handler) and
  is the **only** thing the MCP layer talks to (so SDK swaps are localized).
- stdio transport wiring; default transport is stdio (§8.1).
- Scope/feature gating hook point: if the SDK supports dynamic tool listing, hide
  unavailable tools; else register all and return `feature_disabled` /
  `insufficient_scope` (§9.3). (Logic added in Phase 3; wire the seam now.)

**Success criteria:**
- [ ] `test/integration/mcpServer.test.ts`: server boots over an in-memory/stdio
      transport and responds to `list_tools`.
- [ ] No business logic in registration callbacks — handlers delegate (§13.2, §27.1).

**HLD refs:** §7, §8.1, §9.3, §11.1, §13.2.

### Step 2.2 — Health tool + response bounding

**Goal:** one dummy `health` tool proving the end-to-end MCP path, plus the global
response-size guard.

**Files:** a `health` tool registration; `src/safety/limits.ts` (response truncation).

**Implement:**
- `health` tool returning a small structured object (`{ ok: true, … }`).
- Response bounding: any tool response over `toolResponseBodyCharLimit` is
  truncated and flagged `truncated: true`, never silently cut (§11.1).

**Success criteria:**
- [ ] `test/unit/.../limits.test.ts`: an oversized response is flagged
      `truncated: true` and bounded by `toolResponseBodyCharLimit` (§22.1 #18).
- [ ] Claude Code (or the integration test client) can **list and call** the
      `health` tool over stdio.

**HLD refs:** §11.1, §22.1 (#18), §26.1 acceptance.

### Step 2.3 — CLI skeleton

**Goal:** the CLI entrypoint with the non-auth commands working.

**Files:** `src/index.ts`, `src/cli.ts`.

**Implement (subset of §20):** `--help`, `config init`, `config show`, `start`
(launches the server with the configured/`--transport` value), and a `doctor` stub
(full checks land in Step 6.x). Default HTTP host, when used, is `127.0.0.1` (§8.2).

**Success criteria:**
- [ ] `gmail-mcp-server --help` lists all §20 commands.
- [ ] `config init` writes a valid §10 config to `~/.gmail-mcp/config.json`.
- [ ] `config show` prints the effective (merged) config.
- [ ] `start --transport stdio` boots the server; `claude mcp add gmail -- node
      ./dist/index.js start --transport stdio` lists the `health` tool (§8.1).

**HLD refs:** §8.1, §8.2, §20.

### 🚦 Milestone 1 Gate (§26.1)

- [ ] `npm run build` passes. `npm test` passes.
- [ ] Claude Code can list the one dummy `health` tool over stdio.
- [ ] Config loading + structured errors + basic logging are in place.

---

## Phase 3 — OAuth, scopes, token store (Milestone 2)

### Step 3.1 — Scope profiles & scope enum

**Goal:** the 7 built-in scope profiles and the `Scope` enum.

**Files:** `src/auth/scopeProfiles.ts`.

**Implement:**
- `Scope` enum members exactly as §9.2 table (`GmailMetadata`, `GmailReadonly`,
  `GmailModify`, `GmailCompose`, `GmailSend`, `GmailLabels`, `MailGoogleCom`).
- Profiles `metadata, readonly, modify, compose, send, labels, full` → full OAuth
  URIs. Short-name → `https://www.googleapis.com/auth/<short-name>`; `full` →
  `https://mail.google.com/` (the sole exception, §9.2).

**Success criteria:**
- [ ] `test/unit/auth/scopeProfiles.test.ts`: each profile expands to the exact
      full URI(s); `full` → `https://mail.google.com/` (§22.1 #1).
- [ ] Every `Scope.*` member used in §9.3 examples resolves.

**HLD refs:** §9.2, §22.1 (#1).

### Step 3.2 — Scope gate

**Goal:** runtime "any-of" scope checking per tool.

**Files:** `src/auth/scopeGate.ts`.

**Implement:**
- `REQUIRED_SCOPES` per tool; each tool's authoritative required scopes come from
  its §12 spec (§9.3 note). A tool passes only if (a) its feature flag is on **and**
  (b) the granted token has ≥1 required scope.
- On failure return `feature_disabled` (flag off) or `insufficient_scope` (scope
  missing), with the §11.1 `requiredAnyOf`/`granted` details.

**Success criteria:**
- [ ] `test/unit/auth/scopeGate.test.ts`: granted ⊇ one-of-required → allow;
      none → `insufficient_scope` with correct `requiredAnyOf` (§22.1 #2).
- [ ] Feature-flag-off path returns `feature_disabled`, not `insufficient_scope`.

**HLD refs:** §9.3, §11.1, §22.1 (#2).

### Step 3.3 — Token store

**Goal:** safe persistence of OAuth tokens, with permission hygiene.

**Files:** `src/auth/tokenStore.ts`.

**Implement:**
- Read/write tokens at `~/.gmail-mcp/tokens/<profile>.json` (§9.1), supporting
  multiple profiles.
- Restrictive file perms where possible; warn if perms look too permissive (§16.4 #3–4).

**Success criteria:**
- [ ] Tests: round-trip save/load per profile; missing token → clear "auth needed".
- [ ] Test/assert: a permissive-perms token file triggers a warning.
- [ ] No token value is ever logged (assert via the redaction logger).

**HLD refs:** §9.1, §16.4.

### Step 3.4 — OAuth desktop client

**Goal:** the Google OAuth **Desktop App** flow with refresh.

**Files:** `src/auth/oauthClient.ts`.

**Implement:**
- Desktop-app credentials from `~/.gmail-mcp/credentials.json` (§9.1).
- Authorization + token refresh; on scope change require re-auth (§9.4).

**Success criteria:**
- [ ] Unit test with a mocked OAuth client: refresh path works; scope-change
      forces re-auth.
- [ ] (Opt-in live) `GMAIL_MCP_LIVE_TESTS=1`: a real `auth login` obtains a token.

**HLD refs:** §9.1, §9.4, §22.3.

### Step 3.5 — Auth CLI commands

**Goal:** `auth login/status/logout/revoke` (§9.4, §20).

**Files:** `src/auth/authCommands.ts` (wired into `cli.ts`).

**Implement:**
- `auth login --scope-profile <name>` (§9.2 example).
- `auth status` shows email + granted scopes.
- `logout` deletes local tokens; `revoke` calls Google revocation then deletes (§9.4).

**Success criteria:**
- [ ] `auth status` prints the authenticated email and granted scopes (§26.2).
- [ ] No token printed in any log/output (§26.2, §16.4).
- [ ] `logout` removes the token file; `revoke` attempts Google revocation then removes.

**HLD refs:** §9.2, §9.4, §20, §26.2.

### 🚦 Milestone 2 Gate (§26.2)

- [ ] `auth login --scope-profile readonly` works.
- [ ] `auth status` shows email and granted scopes.
- [ ] Token is never printed in logs.

---

## Phase 4 — MIME parser + read-only tools (Milestone 3 → v0.1.0)

### Step 4.1 — Gmail client wrapper + retries

**Goal:** a single typed wrapper over the Google client with retry/backoff.

**Files:** `src/gmail/gmailClient.ts`.

**Implement:**
- All Gmail calls go through this wrapper; **`gmail` must not import the MCP SDK** (§13.2).
- Retry on 429/500/502/503/504 + network timeouts with exponential backoff + jitter
  (§19). Do **not** retry non-idempotent sends (§19).

**Success criteria:**
- [ ] `test/integration/gmailClient.fake.test.ts`: a fake client returning 429
      then 200 is retried and succeeds (§22.2 #9).
- [ ] A non-idempotent send is not auto-retried.

**HLD refs:** §13.2, §19, §22.2 (#9).

### Step 4.2 — base64url + headers

**Goal:** the two lowest-level MIME primitives.

**Files:** `src/mime/base64url.ts`, `src/mime/headers.ts`.

**Implement:**
- Safe base64url decode that does not crash on malformed input (§14.8–14.9).
- Case-insensitive preservation of key headers (§14.1).

**Success criteria:**
- [ ] Tests: base64url decode of valid and malformed input (no throw; warning on
      bad input) (§22.1 #10, §22.2 #6).
- [ ] Header parse is case-insensitive (§22.1 #4).

**HLD refs:** §14.1, §14.8–14.9, §22.1 (#4, #10).

### Step 4.3 — Recursive MIME tree parser

**Goal:** parse Gmail `MessagePart` trees into bodies + attachment descriptors.

**Files:** `src/mime/parseMessage.ts`, `src/mime/bodyExtractor.ts`,
`src/mime/attachmentExtractor.ts`.

**Implement (§14 requirements):**
- Plain text from `text/plain`; HTML from `text/html` **only when requested** (§14.2–14.3).
- Non-empty filename ⇒ attachment even if disposition missing (§14.4); `inline`
  parts respected per `includeInline` (§14.5–14.6).
- Handle nested `multipart/alternative|mixed|related` and `message/rfc822` (§14.7).
- Attachment discovery from both `body.attachmentId` and inline `body.data` (§5.3).
- Produce the internal `GmailAttachmentDescriptor` (§14); never crash on malformed
  parts — return warnings (§14.9).

**Success criteria:**
- [ ] `test/unit/mime/*`: covers §22.1 #5–#9 (tree parse, text extraction, HTML
      disabled by default, attachment discovery from `attachmentId` and inline `data`).
- [ ] Fixtures §22.2 #1–#8 parse correctly (plain, alt text/html, PDF attachment,
      inline image, nested rfc822, malformed base64, missing filename, huge metadata).
- [ ] HTML body is **not** returned unless explicitly requested (§14.3, §22.1 #7).

**HLD refs:** §5.3, §14, §22.1 (#4–#10), §22.2 (#1–#8).

### Step 4.4 — Body cap & response limits (read path)

**Goal:** enforce body-length limits in the read tools.

**Files:** extend `src/safety/limits.ts`.

**Implement:** `maxBodyCharsPerMessage` (per-call) is capped at config
`maxMessageBodyChars`; truncation sets `body.truncated = true` (§12.4).

**Success criteria:**
- [ ] Test: `maxBodyCharsPerMessage` is clamped to `maxMessageBodyChars` (§22.1 #19).
- [ ] Truncated bodies are flagged, not silently cut.

**HLD refs:** §12.4, §22.1 (#19).

### Step 4.5 — `gmail_get_profile`

**Goal:** first real tool.

**Files:** `src/gmail/profile.ts`, `src/tools/gmailGetProfile.ts`.

**Success criteria:**
- [ ] Output matches §12.1 (`profile`, `grantedScopes`, `enabledFeatures`).
- [ ] Scope-gated to metadata/readonly/modify/`mail.google.com` (§12.1); returns
      `insufficient_scope` when only send/compose granted.
- [ ] Gated by `features.profile` (default true).

**HLD refs:** §9.3, §12.1.

### Step 4.6 — `gmail_list_labels`

**Files:** `src/gmail/labels.ts`, `src/tools/gmailListLabels.ts`.

**Success criteria:**
- [ ] Output matches §12.2; respects `includeSystemLabels`/`includeUserLabels`.
- [ ] **No** pagination inputs (Gmail returns the full set; §18).
- [ ] Gated by `features.labels` (default true).

**HLD refs:** §12.2, §18.

### Step 4.7 — `gmail_search_messages`

**Files:** `src/gmail/search.ts`, `src/tools/gmailSearchMessages.ts`.

**Implement:** `format` enum specific to search: `id` / `summary` / `metadata`
(default `metadata`), with the field subsets in §12.3. Never return full bodies (§12.3).

**Success criteria:**
- [ ] Outputs for `id`, `summary`, `metadata` match the §12.3 field subsets exactly.
- [ ] `maxResults` defaults to `defaultPageSize`, capped at `maxPageSize` (§22.1 #17);
      `pageToken` passthrough + `nextPageToken` returned (§18).
- [ ] Never returns a full body.

**HLD refs:** §12.3, §18, §22.1 (#17).

### Step 4.8 — `gmail_get_message`

**Files:** `src/gmail/messages.ts`, `src/tools/gmailGetMessage.ts`.

**Implement (§12.4):** `format` enum `metadata|parsed|full|raw` (default `parsed`),
distinct from the search enum; `includeBody`, `bodyFormat` (`text|html|both`),
`maxBodyCharsPerMessage`, `includeAttachmentMetadata`, `includeRaw`. Raw and
`includeRaw` require `safety.allowRawMessage` else `feature_disabled`. HTML disabled
by default when `safety.disableRawHtmlBodyByDefault` is true.

**Success criteria:**
- [ ] Output matches §12.4 for `parsed`; `metadata`/`full`/`raw` behave per spec.
- [ ] `bodyFormat` controls which of `text`/`html` is populated; `truncated` set
      when capped.
- [ ] `format:"raw"` / `includeRaw:true` with `allowRawMessage:false` →
      `feature_disabled`.
- [ ] HTML not returned unless explicitly requested or safety allows.

**HLD refs:** §12.4, §16.5.

### Step 4.9 — `gmail_get_thread`

**Files:** `src/gmail/threads.ts`, `src/tools/gmailGetThread.ts`.

**Success criteria:**
- [ ] Output matches §12.5; bodies only when `includeBodies` true, following the
      §12.4 safety rules.
- [ ] `maxMessages` defaults to `defaultPageSize`, capped at `maxPageSize`;
      `maxBodyCharsPerMessage` capped at `maxMessageBodyChars`.
- [ ] `truncated` flag set when the thread is bounded.

**HLD refs:** §12.5, §18.

### 🚦 Milestone 3 Gate (§26.3) — tag `v0.1.0` after Phase 5

- [ ] Can search Gmail and read a bounded message body (live, opt-in).
- [ ] Tool outputs never exceed configured limits.

---

## Phase 5 — Attachments + filesystem safety + audit (Milestone 4 → v0.1.0)

### Step 5.1 — Path guard

**Goal:** the §15.1 download-root containment algorithm.

**Files:** `src/attachments/pathGuard.ts`.

**Implement:** expand `~` → resolve root → resolve relative request → normalize →
require final path is inside root (prefix + separator, or equals root) → else reject
with `path_not_allowed`. Reject absolute paths and `..` after normalization (§12.8).

**Success criteria:**
- [ ] `test/unit/attachments/pathGuard.test.ts`: `..`, absolute paths, and
      symlink-style escapes are rejected with `path_not_allowed` (§22.1 #12).
- [ ] In-root relative paths are accepted and normalized.

**HLD refs:** §12.8, §15.1, §22.1 (#12).

### Step 5.2 — Filename policy

**Files:** `src/attachments/filenamePolicy.ts`.

**Implement (§15.2):** preserve original when `preserveOriginalFilenames` true and
allowed, else generate `gmail-attachment-{messageId}-{partId}`; sanitize control/
reserved chars; trim to ~180 chars before extension; preserve safe extension; apply
blocked-extension policy; warn (don't auto-fail) on ext/MIME mismatch.

**Success criteria:**
- [ ] `test/unit/attachments/filenamePolicy.test.ts`: sanitization, generated-name
      fallback, length trim, extension preservation (§22.1 #11).
- [ ] ext/MIME mismatch yields a warning, not an automatic failure (§15.2 #7).

**HLD refs:** §15.2, §22.1 (#11).

### Step 5.3 — Download policy (blocked ext / MIME allowlist / size)

**Files:** `src/attachments/downloadPolicy.ts`.

**Implement:** blocked extensions from `downloads.blockedExtensions`; MIME allowlist
(when non-empty) ; size vs `maxAttachmentBytes`. These drive `downloadAllowed` /
`blockedReason` (§12.6) and the save-time errors `file_blocked` /
`mime_type_blocked` / `file_too_large` (§17).

**Success criteria:**
- [ ] Tests: blocked extension → `file_blocked`; non-allowlisted MIME (when
      allowlist set) → `mime_type_blocked`; oversize → `file_too_large`
      (§22.1 #14, #15).
- [ ] `blockedReason` values match the §17 codes a save would return (§12.6).

**HLD refs:** §12.6, §15.2, §17, §22.1 (#14–#15).

### Step 5.4 — Hashing + collision policy

**Files:** `src/attachments/hash.ts`, collision logic in `saveAttachment.ts`.

**Implement (§15.3):** `append-counter` (default), `overwrite` (only if allowed),
`fail` (error if exists), `content-addressed` (`{sha256}.{ext}`). sha256 of bytes.

**Success criteria:**
- [ ] `test/unit/attachments/collision.test.ts`: all four policies behave per §15.3
      (§22.1 #13).
- [ ] `fail`-on-existing surfaces as an error (later mapped to `failed`, not
      `skipped`, in bulk; §12.9).

**HLD refs:** §15.3, §22.1 (#13).

### Step 5.5 — Attachment service

**Files:** `src/attachments/attachmentService.ts`, `src/attachments/saveAttachment.ts`,
`src/gmail/` attachment fetch via `gmailClient`.

**Implement:** fetch bytes via `users.messages.attachments.get` (§5.1); honor
`maxAttachmentBytes`; compose path-guard + filename + download policy + collision.

**Success criteria:**
- [ ] Unit tests with fake bytes: end-to-end save honors all policies in order.
- [ ] `attachments → mime/config/fs` only (no forbidden imports, §13.2).

**HLD refs:** §5.1–§5.4, §13.2, §15.

### Step 5.6 — `gmail_list_attachments`

**Files:** `src/tools/gmailListAttachments.ts`.

**Success criteria:**
- [ ] Output matches §12.6, incl. advisory `downloadAllowed` + `blockedReason`.
- [ ] `includeInline` defaults to `downloads.includeInlineAttachmentsByDefault` (§12.6).
- [ ] Gated by `features.attachments`.

**HLD refs:** §12.6, §14.

### Step 5.7 — `gmail_get_attachment`

**Files:** `src/tools/gmailGetAttachment.ts`.

**Success criteria:**
- [ ] Output matches §12.7 (base64 + sha256).
- [ ] `file_too_large` when size > min(per-call `maxBytes`, `maxAttachmentBytes`);
      `maxBytes` defaults small (≈1 MiB) (§12.7).

**HLD refs:** §12.7.

### Step 5.8 — `gmail_save_attachment`

**Files:** `src/tools/gmailSaveAttachment.ts`.

**Success criteria:**
- [ ] Disabled unless **both** `features.attachments` and `downloads.enabled` →
      else `feature_disabled` (§12.8).
- [ ] Saves a PDF under `downloads.rootDir`; output matches §12.8 (`savedAttachment`).
- [ ] Path-traversal and blocked-extension attempts are rejected (§26.4 acceptance).

**HLD refs:** §12.8, §26.4.

### Step 5.9 — `gmail_save_attachments` (bulk)

**Files:** `src/tools/gmailSaveAttachments.ts`.

**Implement (§12.9):** same gates as 5.8; bulk-confirmation when count >
`bulkDownloadConfirmationThreshold` (elicitation or `confirmation_required`); hard
reject when count > `maxBulkDownloadCount` with `invalid_input`; per-item validation
→ `saved` / `skipped` / `failed` arrays (with `messageId`/`attachmentId`/`partId`).

**Success criteria:**
- [ ] Over-threshold triggers confirmation; over `maxBulkDownloadCount` → hard
      `invalid_input` before any download (§12.9).
- [ ] One failing item lands in `failed` without aborting the rest; `fail`-collision
      surfaces in `failed`, content-addressed dup in `skipped` (§12.9).
- [ ] Bulk download confirmation works (§26.4 acceptance).

**HLD refs:** §12.9, §26.4.

### Step 5.10 — Audit logger

**Files:** `src/audit/auditLogger.ts`, `src/audit/auditEvents.ts`.

**Implement (§16.5):** append-only JSONL at `logging.auditLogPath`. May record the
allowed fields (timestamp, tool, profile email, ids, subject, sender, filenames,
paths, sha256, size, status); must **never** record tokens, full bodies, attachment
bytes, or full raw MIME.

**Success criteria:**
- [ ] `test/unit/.../audit.test.ts`: redaction — no token/body/bytes/raw MIME ever
      written; allowed fields present (§22.1 #16).
- [ ] Save/get-attachment actions emit an audit record.

**HLD refs:** §16.5, §22.1 (#16).

### 🚦 Milestone 4 Gate (§26.4) — tag `v0.1.0`

- [ ] Can save a PDF attachment.
- [ ] Path-traversal tests pass. Blocked-extension tests pass.
- [ ] Bulk download confirmation works.

---

## Phase 6 — Write features (Milestone 5 → v0.2.0 / v0.3.0)

### Step 6.1 — Confirmation primitive

**Files:** `src/safety/confirmation.ts`.

**Implement (§16.3):** if MCP elicitation is available, ask interactively; else
require the tool-specific exact `confirmation` string (case-sensitive). Encodes the
rules: send requires confirmation when `requireConfirmationForSend`; trash always;
label modify when `requireConfirmationForModify` or multiple messages.

**Success criteria:**
- [ ] Tests: missing/incorrect confirmation → `confirmation_required`; exact string
      → proceed.
- [ ] Multi-message modify requires confirmation even if the flag is off (§12.14).

**HLD refs:** §16.3, §12.12–§12.15.

### Step 6.2 — RFC822 builder

**Files:** `src/mime/rfc822.ts`.

**Implement:** build a compliant RFC822 message from to/cc/bcc/subject/text/html,
with `replyToMessageId` threading. `attachmentsFromLocalPaths` is **reserved and
must be empty in v1** (§3 #9, §12.10, §12.13).

**Success criteria:**
- [ ] Tests: a built message round-trips through the parser (Step 4.3).
- [ ] Non-empty `attachmentsFromLocalPaths` → `invalid_input` (reserved, §3 #9).

**HLD refs:** §3 (#9), §12.10, §12.13.

### Step 6.3 — Draft tools (`create_draft`, `list_drafts`, `send_draft`)

**Files:** `src/gmail/drafts.ts`, `src/tools/gmailCreateDraft.ts`,
`gmailListDrafts.ts`, `gmailSendDraft.ts`.

**Success criteria:**
- [ ] All three gated by `features.drafts` (default false) → `feature_disabled`
      when off (§12.10–§12.12).
- [ ] Outputs match §12.10/§12.11/§12.12; `list_drafts` paginates per §18.
- [ ] `send_draft` requires confirmation when `requireConfirmationForSend` (§12.12).

**HLD refs:** §12.10–§12.12, §18.

### Step 6.4 — `gmail_send_message`

**Files:** `src/gmail/send.ts`, `src/tools/gmailSendMessage.ts`.

**Success criteria:**
- [ ] Gated by `features.send` (default false); scopes `gmail.send` or
      `mail.google.com` (§12.13).
- [ ] Confirmation enforced when `requireConfirmationForSend` (default).
- [ ] Audit logs send metadata but **never** the full body (§12.13, §16.5).
- [ ] Not auto-retried (non-idempotent, §19).

**HLD refs:** §12.13, §16.5, §19.

### Step 6.5 — `gmail_modify_message_labels`

**Files:** `src/gmail/modify.ts`, `src/tools/gmailModifyMessageLabels.ts`.

**Success criteria:**
- [ ] Gated by `features.modify` (default false); scopes `gmail.modify` /
      `mail.google.com` (§12.14).
- [ ] Confirmation when `requireConfirmationForModify` or multiple messages.
- [ ] Archive/read-unread achieved via label add/remove (no separate tools; §9.2 note).

**HLD refs:** §9.2, §12.14.

### Step 6.6 — `gmail_trash_messages`

**Files:** `src/tools/gmailTrashMessages.ts` (reuse `modify.ts`).

**Success criteria:**
- [ ] Gated by `features.modify`; **always** requires confirmation regardless of
      `requireConfirmationForModify` (§12.15).
- [ ] No permanent delete implemented (§12.15).

**HLD refs:** §12.15.

### Step 6.7 — `gmail_create_label`

**Files:** `src/tools/gmailCreateLabel.ts` (reuse `labels.ts`).

**Success criteria:**
- [ ] Gated by `features.labelsWrite` (default false), **not** `features.labels` (§12.16).
- [ ] Output matches §12.16; v1 is create-only (no update/delete, §9.2).

**HLD refs:** §9.2, §12.16.

### Step 6.8 — `gmail_get_history`

**Files:** `src/gmail/history.ts`, `src/tools/gmailGetHistory.ts`.

**Success criteria:**
- [ ] Gated by `features.history` (default false).
- [ ] Output matches §12.17; paginates per §18.

**HLD refs:** §12.17, §18.

### Step 6.9 — `doctor` full checks

**Files:** extend `cli.ts` doctor command.

**Success criteria:**
- [ ] Performs all 7 §20 checks (Node version, config validity, credentials file,
      token file/scopes, download-root writable, feature-flag↔scope match).
- [ ] Explains missing setup steps clearly (§26.6 acceptance).

**HLD refs:** §20, §26.6.

### 🚦 Milestone 5 Gate (§26.5) — tag `v0.2.0` (labels/modify), then `v0.3.0` (drafts/send)

- [ ] Write tools are hidden or rejected without scopes/flags.
- [ ] Write tools require confirmation.
- [ ] Audit log records write actions.

---

## Phase 7 — Polish, optional HTTP, docs, CI, release (Milestone 6 → v0.4.0 / v1.0.0)

### Step 7.1 — Optional resources & prompts

**Files:** resource/prompt registrations in `src/mcp/`.

**Success criteria:**
- [ ] Read-only bounded resources `gmail://profile|labels|message/{id}|thread/{id}` (§11.2).
- [ ] Prompts `gmail-search-help|safety-guidelines|draft-reply|attachment-workflow`,
      none embedding private data (§11.3).

**HLD refs:** §11.2, §11.3.

### Step 7.2 — Examples

**Files:** `examples/config.readonly.json`, `config.modify.json`, `config.send.json`,
`config.full.json`, `claude-code.mcp.json`.

**Success criteria:**
- [ ] Four config variants differ only in `oauth.scopes` + matching `features`, per
      §10's "four config variants" description (readonly/modify/send/full).
- [ ] Each example validates against the Step 1.2 schema.
- [ ] `claude-code.mcp.json` matches §21.2.

**HLD refs:** §10, §13.1, §21.2, §24.

### Step 7.3 — Public-repo docs

**Files:** `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `.env.example`.

**Success criteria:**
- [ ] README states all 6 mandatory disclaimers/warnings (§24 list 1–6).
- [ ] README includes the §21.1 local-stdio setup steps.
- [ ] `.env.example` documents every supported `GMAIL_MCP_` variable (§10, §24).
- [ ] Published file set matches §24 exactly.

**HLD refs:** §21, §24.

### Step 7.4 — Optional HTTP transport

**Files:** extend `src/mcp/transport.ts`.

**Success criteria:**
- [ ] `start --transport http --host 127.0.0.1 --port 3333` works; default bind is
      `127.0.0.1`, never `0.0.0.0` (§8.2).
- [ ] Remote HTTP (if enabled) requires TLS + auth (§8.2).

**HLD refs:** §8.2. (Tag `v0.4.0`.)

### Step 7.5 — CI/CD

**Files:** `.github/workflows/*.yml`.

**Success criteria:**
- [ ] CI runs install → typecheck → lint → unit tests → build → package smoke test,
      plus secret scanning if available (§23).
- [ ] No real Gmail credentials in CI; live tests never run by default (§22.3, §23).

**HLD refs:** §22.3, §23.

### Step 7.6 — Package smoke test & publish setup

**Success criteria:**
- [ ] `npm pack` / global install exposes the `gmail-mcp-server` bin.
- [ ] A fresh user can install and configure purely from the README (§26.6).
- [ ] No secrets in the repo (secret scan clean).

**HLD refs:** §26.6.

### 🚦 Milestone 6 Gate (§26.6) — tag `v1.0.0` after the DoD below

- [ ] Fresh user can install and configure from README.
- [ ] `doctor` explains missing setup steps.
- [ ] No secrets in repo.

---

## Final acceptance — Definition of Done (§28)

Tag `v1.0.0` only when **every** item holds:

1. [ ] User can install the package locally.
2. [ ] User can configure Gmail OAuth credentials.
3. [ ] User can choose scopes.
4. [ ] Claude Code connects to the MCP server over stdio.
5. [ ] Claude Code can search Gmail messages.
6. [ ] Claude Code can read message summaries and bodies within configured limits.
7. [ ] Claude Code can list and save Gmail attachments.
8. [ ] Write/send/modify tools are available only when enabled and scoped.
9. [ ] Dangerous writes and sends require confirmation.
10. [ ] Path-traversal and unsafe-file tests pass.
11. [ ] Repo has README, SECURITY, examples, and CI.
12. [ ] Codebase is suitable for public review.

---

## Coverage check — every HLD tool has a step

| HLD tool (§12) | Step |
|---|---|
| `gmail_get_profile` (12.1) | 4.5 |
| `gmail_list_labels` (12.2) | 4.6 |
| `gmail_search_messages` (12.3) | 4.7 |
| `gmail_get_message` (12.4) | 4.8 |
| `gmail_get_thread` (12.5) | 4.9 |
| `gmail_list_attachments` (12.6) | 5.6 |
| `gmail_get_attachment` (12.7) | 5.7 |
| `gmail_save_attachment` (12.8) | 5.8 |
| `gmail_save_attachments` (12.9) | 5.9 |
| `gmail_create_draft` (12.10) | 6.3 |
| `gmail_list_drafts` (12.11) | 6.3 |
| `gmail_send_draft` (12.12) | 6.3 |
| `gmail_send_message` (12.13) | 6.4 |
| `gmail_modify_message_labels` (12.14) | 6.5 |
| `gmail_trash_messages` (12.15) | 6.6 |
| `gmail_create_label` (12.16) | 6.7 |
| `gmail_get_history` (12.17) | 6.8 |

All 17 tools (§12), the 11 feature flags (§9.3/§10), the 16 error codes (§17), the
19 unit-test areas (§22.1), and the 10 integration fixtures (§22.2) are covered by
the steps above.
