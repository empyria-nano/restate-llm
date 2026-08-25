import { TerminalError } from '@restatedev/restate-sdk'
import { defineService, withValidation } from '@empyria/restate'
import { createModel } from './Model.js'
import { runAgentLoop } from './LLM.js'

const AskInputSchema = {
	type: 'object',
	properties: {
		// Optional on purpose: a caller with no `loadContext` configured, or one that
		// doesn't need it for a given request, shouldn't be blocked from asking anything —
		// see `ask`'s handler below for the empty-system-prompt/no-skills fallback.
		skillsFolder: { type: 'string' },
		department: { type: 'string' },
		prompt: { type: 'string', minLength: 1 },
		threadId: { type: 'string' },
		resourceId: { type: 'string' },
	},
	required: ['prompt'],
	additionalProperties: false,
}

const AskOutputSchema = {
	type: 'object',
	properties: {
		text: { type: 'string' },
		steps: { type: 'number' },
	},
	required: ['text', 'steps'],
	additionalProperties: false,
}

/**
 * Builds a Restate service that IS an LLM-backed agent: a single `ask` handler that
 * takes a `prompt`, drives {@link runAgentLoop}'s durable, retrying tool-calling loop
 * against the model {@link createModel} builds from `env`, and returns the final
 * answer. This is the function a consuming app calls to stand up its own agent —
 * `defineAgentService`/`createAgentService`-style factories are how every Restate
 * construct in `@empyria/restate` is built (see `Admin.js`'s `defineService`, which
 * this itself sits on top of), not a single shared instance, because `env` (which LLM
 * endpoint/model/key to call) and `loadContext` (this app's own way of turning a
 * request into a system prompt and skill list) are inherently per-app.
 *
 * There's no built-in "agent" primitive in `@restatedev/restate-sdk` — an agent is
 * just a regular Restate service, `defineService`d here on top of `@empyria/restate`.
 * `ask` is a single durable invocation: `loadContext` (if given) runs as its own named
 * `ctx.run('load-context', ...)` step, then every LLM call and every tool call inside
 * {@link runAgentLoop} is its own named, durable step with a bounded retry policy (see
 * `Errors.js`'s `DEFAULT_LLM_RETRY` and `LLM.js` for why the SDK's own `ctx.run`
 * defaults are a poor fit for an LLM call) — a crash resumes exactly where it left off,
 * and every step is visible in Restate's own invocation UI.
 * @param {Object} config
 * @param {{LLM_BASE_URL: string, LLM_API_KEY?: string, MODEL_ID: string}} config.env
 *   Passed straight to {@link createModel} to build the AI SDK Core model `ask` calls,
 *   unless `config.model` is given.
 * @param {import('@ai-sdk/provider').LanguageModelV4} [config.model] Optional. Use an
 *   already-built model instead of having this factory call `createModel(env)` — the
 *   seam that lets tests inject AI SDK's own `MockLanguageModelV4` (see
 *   `test/Agent.test.js`) instead of hitting a real endpoint. Most callers should leave
 *   this unset and just pass `env`.
 * @param {(input: {skillsFolder?: string, department?: string, prompt: string, threadId?: string, resourceId?: string}) => (
 *   {systemPrompt?: string, skills?: Array<{name: string, description: string, body: string}>} |
 *   Promise<{systemPrompt?: string, skills?: Array<{name: string, description: string, body: string}>}>
 * )} [config.loadContext] Optional. Given the full validated `ask` input, resolves the
 *   system prompt and skill list for this request — e.g. reading `skillsFolder`'s
 *   `AGENTS.md`/`.agents/skills/<name>/SKILL.md` files, or looking `department` up in a
 *   config store. Runs inside its own durable `ctx.run` step, so it only executes once
 *   even if the invocation is retried/replayed. Omit it to run with an empty system
 *   prompt and no skills — `prompt` alone is still enough to call the model.
 * @returns {import('@restatedev/restate-sdk').ServiceDefinition<'AgentService', unknown>}
 *   A Restate `ServiceDefinition` — pass it to `setupRestate`'s (or your own endpoint's)
 *   `services` list to register it. Reach it via `ctx.serviceClient({name: 'AgentService'})`
 *   from inside another Restate handler, or over ingress as `POST /AgentService/ask`.
 * @example
 * ```js
 * import { createAgentService } from '@empyria/restate-llm'
 *
 * const AgentService = createAgentService({
 *   env: { LLM_BASE_URL: 'https://agent-bureau.vip/v1', MODEL_ID: 'vllm/ornith-1.5' },
 *   loadContext: async ({ skillsFolder }) =>
 *     skillsFolder ? await loadSkillsFromDisk(skillsFolder) : {},
 * })
 *
 * // register AgentService alongside your other services on the same endpoint, then:
 * // POST /AgentService/ask  { "prompt": "Summarize the Q3 report." }
 * ```
 */
export const createAgentService = ({ env, model = createModel(env), loadContext }) => {
	return defineService({
		name: 'AgentService',
		handlers: {
			/**
			 * @param {import('@restatedev/restate-sdk').Context} ctx
			 * @param {{skillsFolder?: string, department?: string, prompt: string, threadId?: string, resourceId?: string}} input
			 *   `department`/`threadId`/`resourceId`/`skillsFolder` are forwarded to
			 *   `loadContext` (if configured) — this handler doesn't interpret them itself.
			 * @returns {Promise<{text: string, steps: number}>}
			 */
			ask: async (ctx, input) => {
				try {
					return await withValidation(
						AskInputSchema,
						AskOutputSchema,
						async (ctx, validatedInput) => {
							const { prompt } = validatedInput

							let systemPrompt = ''
							let skills = []
							if (loadContext) {
								;({ systemPrompt = '', skills = [] } = await ctx.run(
									'load-context',
									() => loadContext(validatedInput),
								))
							} else {
								console.warn(
									'[AgentService] ask: no loadContext given — running with an empty system prompt and no skills',
								)
							}

							return runAgentLoop(ctx, { model, systemPrompt, skills, prompt })
						},
					)(ctx, input)
				} catch (error) {
					// `withValidation` throws `@empyria/common`'s `EmpyriaError` (a plain `Error`,
					// not restate-sdk's `TerminalError`) on a schema violation. Restate retries any
					// non-`TerminalError` throw forever with backoff — for a malformed request
					// that's not a transient fault, so it can never succeed no matter how many
					// times it's retried. Re-throwing as `TerminalError` here makes Restate fail
					// the invocation immediately instead.
					if (error?.errorName === 'ValidationError') {
						throw new TerminalError(error.message)
					}
					throw error
				}
			},
		},
	})
}
