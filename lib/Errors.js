import { TerminalError, RetryableError } from '@restatedev/restate-sdk'
import { APICallError } from '@ai-sdk/provider'

/**
 * Default bounded retry policy for an LLM call's durable `ctx.run` step.
 *
 * `ctx.run`'s own SDK-wide defaults (`initialRetryInterval: 50ms`, unbounded attempts)
 * are tuned for cheap, fast-failing side effects, not a rate-limited LLM gateway — a
 * 50ms-then-double backoff burns through a 429's typical multi-second cooldown in a
 * handful of attempts, and with no `maxRetryAttempts` it never gives up on a
 * genuinely-broken endpoint. `maxRetryAttempts` also matters independently of the
 * interval tuning: without it, any error this module fails to classify as
 * {@link TerminalError} (see {@link toRestateLLMError}) retries forever — see
 * `AgentService.js` in `restate-agentic-system` for the incident this already caused
 * once for a different (validation) error class.
 */
export const DEFAULT_LLM_RETRY = {
	maxRetryAttempts: 5,
	initialRetryInterval: 1_000,
	maxRetryInterval: 30_000,
	retryIntervalFactor: 2,
}

/**
 * Maps an error thrown by an AI SDK Core call (`generateText`/`streamText`/...) to the
 * error a `ctx.run(name, fn, RunOptions)` closure should throw, so Restate retries
 * exactly the failures worth retrying and stops immediately on the ones that aren't.
 *
 * `@ai-sdk/provider`'s `APICallError` already carries an `isRetryable` flag the AI SDK
 * itself derives from the HTTP status code (true for 408/409/429/5xx, false for
 * 400/401/403/404/422/...) — this reuses that classification instead of re-deriving it
 * from status codes by hand, and layers Restate's two escape hatches on top of it:
 *
 * - Not retryable → {@link TerminalError}, so Restate fails the invocation immediately
 *   instead of retrying an auth/config/bad-request error forever.
 * - Retryable AND the response carried a `Retry-After` header → {@link RetryableError},
 *   so Restate honors the gateway's own requested cooldown instead of guessing one.
 * - Retryable with no such header → the original error, unchanged, so `ctx.run`'s own
 *   `RunOptions` backoff (see {@link DEFAULT_LLM_RETRY}) applies.
 * - Anything that isn't an `APICallError` at all (a thrown `TypeError`, a network-layer
 *   error `fetch` itself throws, ...) is returned unchanged — Restate's default is to
 *   treat any non-`TerminalError` throw as retryable, which is the right default for an
 *   error shape this module doesn't recognize.
 *
 * Call sites re-throw the result — this function never throws itself, only classifies:
 * `catch (error) { throw toRestateLLMError(error) }`.
 * @param {unknown} error
 * @returns {Error}
 */
export function toRestateLLMError(error) {
	if (!APICallError.isInstance(error)) return error

	if (!error.isRetryable) {
		return new TerminalError(error.message, { errorCode: error.statusCode })
	}

	const retryAfterHeader = error.responseHeaders?.['retry-after']
	const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined

	if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
		return RetryableError.from(error, { retryAfter: { seconds: retryAfterSeconds } })
	}

	return error
}
