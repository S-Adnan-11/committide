# Draft endpoint

Offline implementation of `POST /v1/draft`. No service is deployed. The client uses a reserved `.invalid` destination until a separately reviewed service configuration exists. Tests inject inference; no Cloudflare account, key or model download is needed. Build the shared modules with `npm run build`, then run `node --test test/hosted-worker.test.mjs`. The Worker and its configuration stay outside the npm archive.

Only bounded version 1 staged metadata, type policy and optional intent are accepted. Unknown fields, hunks, prompts, models, credentials and uploads are rejected. Paths and intent remain untrusted data in a fixed server prompt. Screening cannot establish that input is safe or truthful. Output must satisfy both wire bounds and shared commit validation.

The disabled-by-default configuration has one allowlisted server model, a 768 completion-token bound and a lifetime admission cap (2, hard maximum 20). Every accepted attempt reserves a slot in one persistent Durable Object before inference. Slots are never refunded, including failures, cancellation and deadlines. The counter has no clock reset or client identifier. Changing its object name, deleting storage or raising the cap needs operational review. Storage/burst errors fail closed. A request-count cap is not an exact neuron or billing cap.

The edge burst binding allows 3 requests/minute per edge-supplied IP and is approximate across locations. It is not used for global accounting. Missing edge identity refuses. `HOSTED_ENABLED=false` disables admission/inference; it cannot revoke work already accepted. The 15-second deadline ends waiting, not necessarily binding processing. No automatic retry or provider switch exists.

The application logs no payloads, prompts, IPs or model replies and disables Worker observability in its sample configuration. The only stored value is a global admission count. Platform data handling and operational logging still need verification before any service rollout. There is no client API token. No account setup or deployment runs in contributor checks.

The schema and fixed prompt are versioned with this endpoint. A model/data-handling/destination change needs renewed disclosure. Real Worker runtime behavior, account Free limits, model reply shape/quality and abuse handling remain rollout work.

References: [atomic storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction), [approximate edge limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [GLM](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), [Granite](https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/).
