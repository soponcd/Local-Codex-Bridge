# LCB-CAPABILITIES-MISMATCH-49 — source candidate, not deployed

## Root cause and boundaries

Production remains `2.1.3-local.1`; source main started at `a6ec1feb69397c348aed51e80b681dbe4eb5ffa4` (`2.3.4-local.1`). Production `src/mcp.ts` stores the first `InitializeCompatibility` and cached result, then `initializeMismatch` compares every later capability set structurally. A single long-lived Tunnel stdio child receives independent handshakes; its physical pipes have no downstream HTTP session identity. The first probe's capability set was incorrectly treated as a permanent session invariant.

On a fresh isolated child using installed bytes, synthetic handshake A with capabilities `{}` succeeds; handshake B with `{sampling:{}}` and identical protocol/clientInfo yields `-32602`, `initialize request is incompatible with the established session: capabilities differs`. Both child processes used only synthetic initialize/tools/list and exited via stdin EOF. Production processes/configuration were untouched. This reproduces the user's exact error, without claiming the unrecorded real browser capability payload has been captured.

Production baseline readback:

| File | SHA-256 |
| --- | --- |
| `src/mcp.ts` | `5a0fc68b8f34488acd53295e9b6ce6c8b03150b658563f48bbc59737a3f5d31c` |
| `dist/src/mcp.js` | `60834b446c6348fb4eea126766600f986c67077f8a0cf7a3aaf2b1fadfd52989` |
| `package.json` | `4d078820b6d6efb2aac2ccd4a188041a426d169ecb4095b62288400fde1796d5` |

Source already contains `91fc288cce27b433fdf549e16d9d570892aef92f`, which fixes the incorrect cache by independently negotiating each handshake. `git diff v2.3.4 -- src/mcp.ts` was empty before this slice; upstream tag is `5cd3aae4651fc6ce54b62571a48eaffb7a47ebd4`. A new source claim must distinguish this preexisting fix from this slice's additional malformed-handshake guard. Merely removing all checks was not a new fix performed here.

## Phase 1 find-wheel record and pattern analysis

Reuse the existing upstream v2.3.4 handshake negotiation. Official Tunnel source at `c8aeedec334db55bbd69bb16db6b71276993d708` confirms shared connections (`pkg/mcpclient/shared_connection_transport.go`, `stdio_command.go`); official `docs/connectors.md` confirms no HTTP session id for stdio and single active instance per tunnel. MCP's 2025-06-18 InitializeRequest requires protocolVersion, capabilities and clientInfo. Links are bound in `PROTOCOL-ASSUMPTIONS.md`.

This directly fits this single-owner local bridge. A separate session registry would lack an authenticated identity on the downstream pipe and add unnecessary state. Development cost is a narrow validation/test/doc patch, rollout cost is a separately reviewed source upgrade, growth cost adds no dependency or per-client store. Usage and monetary cost: unknown.

## Test-first and implementation evidence

The new test `MCP rejects malformed initialize handshakes before opening or changing readiness` was added first. Before source modification, `npm run build && node --test --test-name-pattern='malformed initialize' dist/test/mcp.test.js` produced RED: expected error code `-32602`, actual `undefined` because capabilities/clientInfo shape was unchecked. Initial diagnostic runtime was Node 22.21.1 (unsupported by package engines); the same new test is separately run against an isolated archive of the pre-fix main with the supported Node 26.3.1.

The only runtime patch validates required metadata and recognized capability object shapes before setting readiness. Unknown additive capabilities remain extensible. Handshakes are negotiated independently, without cached client capability/identity state or any invented session key. Existing scoped pending approval, typed active-id and cancellation logic is unchanged. The regression additionally performs `codex_threads(limit:1)` after changed legal handshakes against the existing fake native stdio child, returning `stored-thread`; it does not touch real persisted threads.

Formal runtime: `/opt/homebrew/bin/node`, v26.3.1. Typecheck/build PASS. Normal `npm test` PASS: shared 401 tests, 399 pass, 2 skips, 0 failures/cancellations; macOS platform 5/5 pass. Full MCP file 19/19 pass. Unsupported Node22's observation timer cancellation was diagnostic only and required no source change. No new capability-dependent client RPC, auth/origin modification, auto-retry, runtime reset or multi-tenant claim was added.

## Candidate and rollout contract

Prepare a new `2.3.4-local.1` source candidate distinguished by immutable source commit and payload digests, not the already sealed `2.1.3-local.1-candidate.10`. Production must remain unchanged until independent review GO and authorized deployment. The existing overflow-era `package-release.mjs`/`deploy-fix.mjs` allowlists are tied to historical incident provenance and do not cover this main upgrade (`src/mcp.ts` included). They must not be expanded silently or used with a fabricated old manifest. This slice does not change those executors.

Before production apply, freeze a new exact source-to-installed manifest and trust root, refresh production and host identity, and back up all affected files plus full dist with hashes. Explicitly review the full installed 2.1.3 → source 2.3.4 surface change (8 → 12 tools and structuredContent success transport). Stage and verify the clean built dist before atomic replacement. Preserve credentials, user history and unrelated host files. Restart only `gui/<uid>/com.openai.tunnel-client.lcb-remote` via `kickstart -k`; no broad process termination.

Verification must prove a newly loaded Bridge version/digest by daemon attestation, healthy inner route, repeated valid handshakes with different capabilities and protocol versions, rejected malformed handshake, tools/list exposing twelve tools, and a real ChatGPT web `codex_threads(limit:1)` returning a thread metadata page. Outer health 200 or a direct native call is insufficient. Do not record real metadata bodies; retain only bounded source/count/error classification.

On any failed apply/verification, restore the exact backed-up files and dist, perform the same targeted restart and prove the old loaded digest/route. Restored file bytes alone are insufficient. If old loaded-instance proof fails, report `MANUAL_RECOVERY_REQUIRED`. Browser acceptance remains unverified until that actual post-deployment web call succeeds.

Routing record: difficult slice | requested gpt-6.1-sol/high (runtime identity unverified) | bounded source debugging and implementation | one root-cause fix inherited from upstream, one new guard attempt | local source validation PASS | production/browser not deployed or accepted; usage/cost unknown.
