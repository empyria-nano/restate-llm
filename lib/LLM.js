import { generateText, tool, jsonSchema } from 'ai'
import { TerminalError } from '@restatedev/restate-sdk'
import { defineSchema, string } from '@empyria/common'
import { DEFAULT_LLM_RETRY, toRestateLLMError } from './Errors.js'

/**
 * Drives an AI SDK Core tool-calling loop ONE round at a time, called from inside a
 * Restate handler — deliberately NOT `generateText`'s own multi-step `stopWhen` loop
 * wrapped in a single `ctx.run()`. Wrapping the whole multi-step loop in one step would
 * make it atomic to Restate: a crash mid-loop would replay the entire thing from
 * scratch, re-billing already-completed LLM calls and — critically — re-executing tool
 * calls that already ran, which is unsafe for any non-idempotent tool (send an email,
 * create a folder, ...). Here, every LLM call and every tool execution is its own
 * named, durable `ctx.run()` step, so a crash resumes exactly where it left off and
 * nothing runs twice. This is also what makes execution auditable in Restate's own UI —
 * each step shows up by name in the invocation's journal.
 *
 * Tools are defined WITHOUT an `execute` function on purpose: with no `execute`, AI SDK
 * returns the requested call instead of auto-running it, which is what lets this loop
 * (not AI SDK) own each tool execution as its own Restate step.
 * @param {import('@restatedev/restate-sdk').Context} ctx
 * @param {{
 *   model: import('@ai-sdk/provider').LanguageModelV4,
 *   systemPrompt: string,
 *   skills: Array<{name: string, description: string, body: string}>,
 *   prompt: string,
 *   maxSteps?: number,
 *   extraTools?: Record<string, {description: string, inputSchema: object, execute: (input: any) => Promise<any>}>,
 *   retry?: import('@restatedev/restate-sdk').RunOptions<any>,
 * }} params `inputSchema` on each extra tool is a plain JSON Schema object — built with
 *   `@empyria/common`'s `defineSchema`/`string`/`number`/... (same convention
 *   `AgentService.js` uses for its own input/output validation), not Zod. `retry`
 *   overrides {@link DEFAULT_LLM_RETRY}, the bounded `RunOptions` applied to every
 *   `llm-step-*` call — see `Errors.js` for why the SDK's own defaults are a poor fit
 *   here.
 * @returns {Promise<{text: string, steps: number}>}
 */
export async function runAgentLoop(
	ctx,
	{
		model,
		systemPrompt,
		skills,
		prompt,
		maxSteps = 8,
		extraTools = {},
		retry = DEFAULT_LLM_RETRY,
	},
) {
	const system = buildSystemPrompt(systemPrompt, skills)
	const tools = buildToolDefs(extraTools)
	const messages = [{ role: 'user', content: prompt }]

	for (let step = 0; step < maxSteps; step++) {
		// `ctx.run` JSON-serializes whatever the callback returns to store it in
		// Restate's journal, then hands back that serialized/deserialized copy — not
		// the live object — so replay is deterministic. AI SDK Core's `generateText`
		// result exposes `response` as a non-enumerable getter, which `JSON.stringify`
		// silently drops; returning the raw result here left `result.response`
		// `undefined` on the far side of `ctx.run`. Extract the plain fields the loop
		// actually needs *inside* the callback instead, so they survive the round trip.
		const result = await ctx.run(
			`llm-step-${step}`,
			async () => {
				try {
					// `maxRetries: 0` — AI SDK Core retries transient failures internally by
					// default (2 attempts, its own backoff, invisible to Restate's journal).
					// Left on, a failure can retry twice inside AI SDK *and then* however many
					// times `RunOptions` below allows, with two independent backoff clocks
					// stacking on top of each other. Disabling it makes `ctx.run`'s `RunOptions`
					// the single, observable retry authority for this step.
					const r = await generateText({ model, system, messages, tools, maxRetries: 0 })
					return {
						text: r.text,
						toolCalls: r.toolCalls,
						responseMessages: r.response.messages,
					}
				} catch (error) {
					throw toRestateLLMError(error)
				}
			},
			retry,
		)

		messages.push(...result.responseMessages)

		if (result.toolCalls.length === 0) {
			return { text: result.text, steps: step + 1 }
		}

		for (const call of result.toolCalls) {
			const output = await ctx.run(`tool:${call.toolName}-${step}`, () =>
				executeTool(call, { skills, extraTools }),
			)
			messages.push({
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: call.toolCallId,
						toolName: call.toolName,
						output,
					},
				],
			})
		}
	}

	// A plain `Error` here would retry the ENTIRE invocation from scratch forever (no
	// handler-level `retryPolicy` is set) — same trap `AgentService.js` documents having
	// hit once already for a validation error. Exceeding `maxSteps` isn't a transient
	// fault a retry can fix, so this fails the invocation immediately instead.
	throw new TerminalError(`Agent loop exceeded maxSteps (${maxSteps}) without a final answer`)
}

function buildSystemPrompt(systemPrompt, skills) {
	if (skills.length === 0) return systemPrompt

	const index = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
	const instructions = `Available skills — call load_skill with a skill's name to read its full instructions before following them:\n${index}`
	return [systemPrompt, instructions].filter(Boolean).join('\n\n')
}

const LOAD_SKILL_INPUT_SCHEMA = defineSchema({ name: string() })

function buildToolDefs(extraTools) {
	const loadSkillTool = tool({
		description:
			"Load the full instructions for a named skill, by the name shown in the system prompt's skill index.",
		inputSchema: jsonSchema(LOAD_SKILL_INPUT_SCHEMA),
	})

	const extraToolDefs = Object.fromEntries(
		Object.entries(extraTools).map(([name, def]) => [
			name,
			tool({ description: def.description, inputSchema: jsonSchema(def.inputSchema) }),
		]),
	)

	return { load_skill: loadSkillTool, ...extraToolDefs }
}

async function executeTool(call, { skills, extraTools }) {
	if (call.toolName === 'load_skill') {
		const skill = skills.find((s) => s.name === call.input.name)
		return skill
			? { type: 'text', value: skill.body }
			: { type: 'error-text', value: `No skill named "${call.input.name}" is available.` }
	}

	const def = extraTools[call.toolName]
	if (!def) {
		return { type: 'error-text', value: `Unknown tool "${call.toolName}".` }
	}

	try {
		const value = await def.execute(call.input)
		return { type: 'json', value }
	} catch (error) {
		return { type: 'error-text', value: error instanceof Error ? error.message : String(error) }
	}
}
