# Development checks

Build the CLI before running the provider contract tests:

```sh
npm run build
node --test test/draft-provider.test.mjs
```

`lib/draft-provider.mjs` defines a versioned JSON boundary for mock draft
providers. It reexports the compiled runtime contract in `src/provider.ts`, shared with the
composer. The development entry point and tests stay outside the npm package.
The contract itself has no HTTP client or provider credential handling.

Requests carry `{version:1, policy:{allowedTypes}, staged:{complete,entries},
intent}`. Each entry has a status (`A`, `M`, `D`, `R` or `T`), relative `path`,
`kind` (`text`, `binary`, `submodule` or `symlink`), `additions` and `deletions`.
Renames also require `previousPath`. Non-text counts are `null`. Unknown fields,
incomplete/empty metadata, duplicate paths, unsafe paths and credential-like
content refuse. The whole JSON request is bounded to 16 KiB of UTF-8.

Metadata is the default. Optional `hunks:[{path,patch}]` require a separate
`allowHunks:true` choice, must name staged text entries and exclude generated or
vendor paths. Callers must prove the input came from the reviewed index and
show the actual payload before any future remote use. Schema validation and
secret screening cannot establish provenance or prove that content is safe.

Responses carry `{version:1,draft,uncertainty}`. The draft has `type`, `scope`,
`description`, `body`, `breaking`, `breakingDetails`, `refs` and `footers`.
Unknown fields, unsafe controls, inconsistent breaking details and failed shared
message validation refuse. The response is bounded to 32 KiB of UTF-8. A valid
format says nothing about factual accuracy or whether the draft is useful.

These byte limits are local bounds, not token counts or provider entitlements.
All contract tests use fictional content; they do not measure model quality.

`prepareDraftRequest(json, options)` returns the canonical validated bytes.
`runDraftProvider(json, transport, {isCurrent, signal, timeoutMs, allowHunks})`
exercises exactly one explicitly supplied mock transport. The callback receives
`(requestJson, {signal})` and returns the complete response JSON string. The
required `isCurrent` callback checks the reviewed input and policy before and
after that call. Cancellation or a deadline rejects waiting even if the mock
ignores its signal; late results are discarded. Errors are redacted, with no
retry or fallback. The deadline also bounds asynchronous state checks.
It cannot interrupt synchronous JavaScript.

The result is an unapproved draft plus UTF-8 request/response byte counts and
elapsed mock time. It never commits or grants consent. Callers own any future
disclosure/review UI, input provenance, stream bounds and provider-specific
controls. Cancelling waiting cannot prove remote processing stopped. Mock time
and serialized bytes are not inference latency, metered tokens or model quality.
