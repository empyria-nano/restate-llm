import { describe, test, expect } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { TerminalError, RetryableError } from '@restatedev/restate-sdk'
import { APICallError } from '@ai-sdk/provider'
import { runAgentLoop } from '../lib/LLM.js'
import { DEFAULT_LLM_RETRY } from '../lib/Errors.js'

/**
 * A minimal stand-in for Restate's `Context.run` — per this workspace's testing
 * convention, handlers and the logic they call are unit-tested against a mocked `ctx`,
 * never a live Restate server. Unlike a bare pass-through, this also records the
 * `RunOptions` each step was called with, so tests can assert `runAgentLoop` actually
 * hands `ctx.run` a bounded retry policy instead of relying on its unbounded defaults.
 */
function fakeCtx() {
	const steps = []
	return {
		steps,
		run: async (name, fn, options) => {
			steps.push({ name, options })
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

describe('runAgentLoop retry policy', () => {
	test('applies DEFAULT_LLM_RETRY to each llm-step by default', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })

		await runAgentLoop(ctx, { model, systemPrompt: '', skills: [], prompt: 'hello' })

		const llmStep = ctx.steps.find((s) => s.name === 'llm-step-0')
		expect(llmStep.options).toBe(DEFAULT_LLM_RETRY)
	})

	test('honors a caller-supplied retry override', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({ doGenerate: textResult('hi') })
		const retry = { maxRetryAttempts: 1 }

		await runAgentLoop(ctx, { model, systemPrompt: '', skills: [], prompt: 'hello', retry })

		const llmStep = ctx.steps.find((s) => s.name === 'llm-step-0')
		expect(llmStep.options).toBe(retry)
	})

	test('a non-retryable model failure surfaces from ctx.run as a TerminalError, not a bare rejection', async () => {
		const ctx = fakeCtx()
		const authError = new APICallError({
			message: 'Invalid API key',
			url: 'https://llm.example/v1/chat/completions',
			requestBodyValues: {},
			statusCode: 401,
			isRetryable: false,
		})
		const model = new MockLanguageModelV4({
			doGenerate: () => {
				throw authError
			},
		})

		await expect(
			runAgentLoop(ctx, { model, systemPrompt: '', skills: [], prompt: 'hello' }),
		).rejects.toThrow(TerminalError)
	})

	test('a rate-limited model failure with Retry-After surfaces as a RetryableError honoring it', async () => {
		const ctx = fakeCtx()
		const rateLimitError = new APICallError({
			message: 'Rate limited',
			url: 'https://llm.example/v1/chat/completions',
			requestBodyValues: {},
			statusCode: 429,
			isRetryable: true,
			responseHeaders: { 'retry-after': '5' },
		})
		const model = new MockLanguageModelV4({
			doGenerate: () => {
				throw rateLimitError
			},
		})

		let caught
		try {
			await runAgentLoop(ctx, { model, systemPrompt: '', skills: [], prompt: 'hello' })
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(RetryableError)
		expect(caught.retryAfter).toEqual({ seconds: 5 })
	})

	test('exceeding maxSteps fails as a TerminalError instead of a plain Error Restate would retry forever', async () => {
		const ctx = fakeCtx()
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call_1',
						toolName: 'load_skill',
						input: '{}',
					},
				],
				finishReason: 'tool-calls',
				usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
				warnings: [],
			},
		})

		await expect(
			runAgentLoop(ctx, {
				model,
				systemPrompt: '',
				skills: [],
				prompt: 'hello',
				maxSteps: 1,
			}),
		).rejects.toThrow(TerminalError)
	})
})
