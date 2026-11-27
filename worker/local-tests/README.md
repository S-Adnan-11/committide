# Local Worker runtime checks

From the repository root, run `npm ci` and `npm run build`. Then run `npm ci --prefix worker/local-tests` and `npm test --prefix worker/local-tests`.

These checks execute the unchanged Worker and its Admission class inside workerd with real SQLite-backed Durable Objects and isolated temporary storage. Two Worker instances share one counter. Runtime restart, concurrent cap admission, model changes, disabled service, failed inference, no refunds and read-only readiness are exercised. All outbound Worker fetches are intercepted locally; a fake provider attempt verifies the block. AI and burst bindings are local RPC fakes. No account, credentials, real inference or remote development is used. The test storage is discarded and never points to a deployed namespace.

The deployment sample and pinned local engine both use compatibility date 2026-07-30. The tests read that date and the entry module from the sample configuration. Cloudflare edge/account/model behavior still requires rollout verification. This suite proves local runtime/storage behavior, not model quality or a deployed service. The package is development-only, private and outside the CLI npm archive.
