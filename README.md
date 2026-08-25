# @empyria/restate-llm

[Restate.dev](https://restate.dev) helpers for calling out to an LLM from inside a Restate
handler, built on top of [`@empyria/restate`](https://github.com/empyria-nano/guard-restate):
a durable, retrying tool-calling loop against any OpenAI-compatible endpoint (via
[AI SDK Core](https://ai-sdk.dev)), a bounded retry policy tuned for LLM calls specifically,
and a ready-made Restate service (`createAgentService`) that wraps it all into a single
`ask` handler a consuming app can register and call.

Targets Restate server `1.7.x` and `@restatedev/restate-sdk` `^1.16.9`.

## Requirements

- Bun `>=1.4.0` or Node.js `>=26`
- Plain ESM, no build step, no TypeScript

## Install

```bash
bun add @empyria/restate-llm
```

## Usage

The common case: stand up an LLM-backed Restate service and register it on your endpoint.

```js
import { createAgentService } from '@empyria/restate-llm'
import { setupRestate } from '@empyria/restate'

const AgentService = createAgentService({
	env: {
		LLM_BASE_URL: 'https://agent-bureau.vip/v1',
		LLM_API_KEY: process.env.LLM_API_KEY,
		MODEL_ID: 'vllm/ornith-1.5',
	},
})

await setupRestate({
	restateAdminURL: process.env.RESTATE_ADMIN_URL,
	host: '0.0.0.0',
	port: 9080,
	services: [AgentService],
})
```

```bash
# 8080 is restate-server's own ingress port by default — not the 9080 this service
# listens on above, which is only where restate-server reaches this deployment.
curl -X POST localhost:8080/AgentService/ask -d '{"prompt": "Summarize the Q3 report."}'
```

Give the agent a system prompt/skills by passing `loadContext` — it runs as its own durable
step, so it only executes once even if the invocation is retried:

```js
const AgentService = createAgentService({
	env: { LLM_BASE_URL, MODEL_ID },
	loadContext: async ({ skillsFolder }) =>
		skillsFolder ? await loadSkillsFromDisk(skillsFolder) : { systemPrompt: '', skills: [] },
})
```

Everything is re-exported from the package root via [index.js](./index.js). Individual
modules under `lib/` can also be imported directly if you only need one:

```js
import { runAgentLoop } from '@empyria/restate-llm/lib/LLM.js'
```

## Modules

| Module                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [lib/Agent.js](./lib/Agent.js)   | `createAgentService` — the function a consuming app calls to build its own LLM-backed Restate service: a single `ask` handler (validated input/output) that resolves a system prompt/skills via an optional `loadContext` step, then drives `runAgentLoop`. There's no built-in "agent" primitive in `@restatedev/restate-sdk`; this is a regular `defineService` underneath.                                                                                                              |
| [lib/LLM.js](./lib/LLM.js)       | `runAgentLoop` — drives an AI SDK Core tool-calling loop one round at a time, with every LLM call and every tool call as its own named, durable `ctx.run()` step (never the whole multi-step loop as one atomic step — see the file's own comment for why that would be unsafe for non-idempotent tools). Applies `DEFAULT_LLM_RETRY` to each LLM-call step and disables AI SDK's own internal retries (`maxRetries: 0`) so Restate's `ctx.run` is the single, observable retry authority. |
| [lib/Model.js](./lib/Model.js)   | `createModel` — builds an AI SDK Core model pointed at an OpenAI-compatible endpoint (`LLM_BASE_URL`/`LLM_API_KEY`/`MODEL_ID`), e.g. Bifrost.                                                                                                                                                                                                                                                                                                                                              |
| [lib/Errors.js](./lib/Errors.js) | `toRestateLLMError`/`DEFAULT_LLM_RETRY` — maps an AI SDK `APICallError` to the error Restate expects: non-retryable → `TerminalError` (fails the invocation immediately instead of retrying an auth/config error forever), retryable with a `Retry-After` header → `RetryableError` honoring it, anything else passed through unchanged so `ctx.run`'s own bounded backoff applies.                                                                                                        |

There is no built-in "agent" primitive in `@restatedev/restate-sdk` — `createAgentService`
is a regular Restate service built on `@empyria/restate`'s `defineService`/`withValidation`,
the same way every other construct in that package is built (`Cron.js`'s `cronJob`,
`Caller.js`'s `CallerServiceDef`, ...).

### Why a dedicated retry policy for LLM calls

`ctx.run`'s own SDK-wide defaults (50ms initial backoff, unbounded attempts) are tuned for
cheap, fast-failing side effects, not a rate-limited LLM gateway, and — more importantly —
Restate retries **any non-`TerminalError` throw forever** by default. A bad API key or a
malformed request is not a transient fault; left unclassified, it retries indefinitely
inside a durable invocation while a caller sits blocked on it. `lib/Errors.js`'s
`toRestateLLMError` fixes the classification (using AI SDK's own `isRetryable` signal, itself
derived from HTTP status codes), and `DEFAULT_LLM_RETRY` bounds the attempts. See the JSDoc
in `lib/Errors.js` and `lib/LLM.js` for the full reasoning.

Every exported function is documented with JSDoc directly in its source file — hovering a
function in VSCode or Zed shows its parameters and return type without any extra tooling,
since both editors read JSDoc from plain `.js` files automatically.

Tests live under [test/](./test/), one file per module, mocking `ctx`/the model (AI SDK's
own `MockLanguageModelV4`) rather than requiring a live Restate server or LLM endpoint.

### Note on dependencies

`@ag-ui/encoder` is currently listed as a dependency but not used by any module here — it's
not wired up yet.

## Scripts

```bash
bun run format       # check formatting (oxfmt)
bun run format:fix   # apply formatting
bun run lint         # lint (oxlint)
bun run lint:fix     # lint and fix
bun run test         # run tests with coverage
```

## License

MIT © Imre Fazekas
