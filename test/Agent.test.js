import { describe, test, expect } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError } from '@restatedev/restate-sdk'
import { createAgentService } from '../lib/Agent.js'

/**
 * A minimal stand-in for Restate's `Context` — per this workspace's testing
 * convention (see `test/LLM.test.js`, `restate-agentic-system`'s
 * `AgentService.test.js`), handlers are unit-tested directly against a mocked `ctx`,
 * never a live Restate server. Records step names so tests can assert `loadContext`
 * runs inside its own durable step.
 */
function fakeCtx() {
	const stepNames = []
	return {
		stepNames,
		run: async (name, fn) => {
			stepNames.push(name)
			return await fn()
		},
	}
}

function textResult(text) {
	return {
		content: [{ type: 'text', text }],
		finishReason: 'stop',
		usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
		warnings: [],
	}
}

// `env` is required by `createAgentService`'s signature but never used once `model` is
// given (see `Agent.js`'s `model = createModel(env)` default parameter — `env` is only
// read to build that default). A dummy value here is enough.
const env = { LLM_BASE_URL: 'https://unused.example', MODEL_ID: 'unused' }

describe('createAgentService', () => {
	test('rejects an input missing the required prompt field', async () => {
		const AgentService = createAgentService({ env, model: new MockLanguageModelV4() })
		await expect(AgentService.service.ask(fakeCtx(), {})).rejects.toThrow(TerminalError)
	})

	test('rejects an unknown field (additionalProperties: false)', async () => {
		const AgentService = createAgentService({ env, model: new MockLanguageModelV4() })
		await expect(
			AgentService.service.ask(fakeCtx(), { prompt: 'hi', notAField: true }),
		).rejects.toThrow(TerminalError)
	})

	test('sends the caller’s own prompt to the model, not a value from loadContext', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('Sure, here you go.') })
		const AgentService = createAgentService({
			env,
			model,
			// A loadContext that returns its own `prompt` field on purpose — Agent.js must
			// ignore it. This is the exact bug this test file was written to catch: an
			// earlier version discarded the caller's `prompt` in favor of whatever
			// loadContext returned.
			loadContext: async () => ({ systemPrompt: '', skills: [], prompt: 'HIJACKED' }),
		})

		const result = await AgentService.service.ask(fakeCtx(), { prompt: 'REAL PROMPT' })

		expect(result).toEqual({ text: 'Sure, here you go.', steps: 1 })
		const sentPrompt = JSON.stringify(model.doGenerateCalls[0].prompt)
		expect(sentPrompt).toContain('REAL PROMPT')
		expect(sentPrompt).not.toContain('HIJACKED')
	})

	test('loadContext receives the full validated input — not an undefined "environment" field', async () => {
		let receivedInput
		const model = new MockLanguageModelV4({ doGenerate: textResult('ok') })
		const AgentService = createAgentService({
			env,
			model,
			loadContext: async (input) => {
				receivedInput = input
				return { systemPrompt: '', skills: [] }
			},
		})

		await AgentService.service.ask(fakeCtx(), {
			prompt: 'Summarize the report.',
			department: 'finance',
			threadId: 'thread-1',
		})

		expect(receivedInput).toEqual({
			prompt: 'Summarize the report.',
			department: 'finance',
			threadId: 'thread-1',
		})
	})

	test('loadContext’s systemPrompt reaches the model, and runs as its own durable step', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('ok') })
		const ctx = fakeCtx()
		const AgentService = createAgentService({
			env,
			model,
			loadContext: async () => ({ systemPrompt: 'Be terse.', skills: [] }),
		})

		await AgentService.service.ask(ctx, { prompt: 'hi' })

		expect(ctx.stepNames).toContain('load-context')
		expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain('Be terse.')
	})

	test('runs with an empty system prompt and no skills when loadContext is omitted', async () => {
		const model = new MockLanguageModelV4({ doGenerate: textResult('ok') })
		const AgentService = createAgentService({ env, model })

		const result = await AgentService.service.ask(fakeCtx(), { prompt: 'hi' })

		expect(result).toEqual({ text: 'ok', steps: 1 })
	})
})
