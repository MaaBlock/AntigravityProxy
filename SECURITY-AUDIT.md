# Security review — 2026-08-10

Reviewed source: [`frieser/antigravity-proxy`](https://github.com/frieser/antigravity-proxy), tag `v0.7.0`, commit `573aa4752735c7bcbaf5c1cd40388c5eff7d8faa`.

This is a static review, not a proof that malicious behavior is impossible.

## Checks performed

- Cloned the exact tag and checked its Git object database with `git fsck`.
- Searched the runtime TypeScript source for outbound URLs, subprocess execution, plugin loading, telemetry, analytics, automatic updates, and remote code loading.
- Ran the included unit tests. Four tests pass; nine transformer tests currently fail because the upstream test suite does not initialize its proxy configuration. This is an upstream test defect, not a passing verification result.

## Findings

- Runtime requests are directed to Google OAuth and Google Cloud Code / Antigravity endpoints. No telemetry, auto-update, plugin downloader, child-process invocation, or non-Google runtime endpoint was found in the reviewed source.
- OAuth refresh tokens are stored in `data/antigravity-accounts.json` as plaintext JSON. The directory is local-only and ignored by Git, but anyone with access to this Windows account or Docker Desktop file sharing can read it.
- The proxy itself does not enforce client API authentication. The Compose configuration binds it only to `127.0.0.1`, drops Linux capabilities, uses a read-only filesystem, and mounts the reviewed code read-only.
- Local execution includes one security-only patch: the upstream server's hard-coded `0.0.0.0` bind is replaced with `HOST` (default `127.0.0.1`). No request, OAuth, credential, or model-routing code was changed.
- The project uses unofficial, reverse-engineered Antigravity APIs. Google may change the protocol, restrict the account, or treat this use as a terms-of-service violation.

## Supply-chain controls

- The proxy source is checked out at the fixed commit above; do not run `git pull` or `bunx antigravity-proxy`.
- The Bun runtime image is pinned by immutable digest in `compose.yaml`.
- Do not add dashboards, plugins, auto-updaters, tunnels, or extra providers without reviewing them separately.
