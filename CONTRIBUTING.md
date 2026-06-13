# Contributing

Thanks for your interest in improving `gmail-mcp-server`. This project aims to be a
clean, well-tested, public-review-ready reference MCP server.

## Development setup

```bash
git clone https://github.com/Yarovinsky/gmail-mcp-server.git
cd gmail-mcp-server
npm install
npm run build
npm test
```

Requirements: Node.js >= 20. The project is ESM TypeScript with `NodeNext` module
resolution — **relative imports must use the `.js` extension** (e.g.
`import { ok } from './util/result.js'`).

## Scripts

| Script                                    | What it does                                                      |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `npm run build`                           | Type-check and compile to `dist/` (`tsc`).                        |
| `npm run typecheck`                       | Type-check only (`tsc --noEmit`).                                 |
| `npm run lint`                            | ESLint (zero warnings expected).                                  |
| `npm run format` / `npm run format:check` | Prettier write / check.                                           |
| `npm test`                                | Run the full Vitest suite.                                        |
| `npm run test:watch`                      | Vitest in watch mode.                                             |
| `npm run smoke`                           | Pack the tarball and verify the installed `gmail-mcp-server` bin. |

Before opening a PR, make sure **`npm run build`, `npm run lint`, `npm run format:check`,
and `npm test` are all green.**

## Architecture conventions

The design specification is [docs/hld/GMAIL_MCP_SERVER_HLD.md](docs/hld/GMAIL_MCP_SERVER_HLD.md).
Please keep these invariants:

- **Layering / dependency direction** (HLD §13.2): `tools → gmail/auth/safety/audit/attachments`,
  `attachments → mime/config/fs`, `mcp → tools`, `gmail → Google client`. The `gmail`,
  `auth`, and `attachments` layers must **not** import the MCP SDK. `attachments` must not
  import `gmail`.
- **No business logic in MCP registration callbacks** — handlers delegate to a layer
  function.
- **Typed inputs**: every tool/external input is guarded by a Zod schema.
- **Stable errors**: use the canonical error codes/factory in `src/mcp/errors.ts`; never
  throw ad-hoc strings.
- **No raw Gmail passthrough tool**, ever.
- **Never log or return OAuth tokens.** Keep the audit allowlist intact.
- New code lives beside its tests in `test/unit/<area>/` (unit) or `test/integration/`.

## Tests

- Unit and integration tests use **fake Gmail API clients** — no real network calls.
- Live Gmail tests are **opt-in only** and never run in CI:
  `GMAIL_MCP_LIVE_TESTS=1 npm test`.
- Add tests for every behavior change; prefer covering the success path, the error/edge
  cases, and the relevant safety boundary.

## Commit and PR guidelines

- Use clear, conventional-style commit subjects (e.g. `feat(send): ...`, `fix(mime): ...`,
  `docs: ...`).
- Keep PRs focused; describe the change, the testing done, and any HLD section it touches.
- If a change reveals a gap or contradiction in the HLD, call it out rather than silently
  diverging.

## Security

Please do not file public issues for undisclosed vulnerabilities — see
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
