import { type ModelOption, type ModelProvider } from './types';

export const MODEL_OPTIONS: Record<ModelProvider, ModelOption[]> = {
	openai: [
		{ value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
		{ value: 'gpt-4o', label: 'gpt-4o' },
		{ value: 'o1-mini', label: 'o1-mini' }
	],
	anthropic: [
		{ value: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet-latest' },
		{ value: 'claude-3-7-sonnet-latest', label: 'claude-3-7-sonnet-latest' }
	],
	ollama: [
		{ value: 'qwen2.5-coder:7b', label: 'qwen2.5-coder:7b' },
		{ value: 'deepseek-coder:6.7b', label: 'deepseek-coder:6.7b' },
		{ value: 'llama3.1:8b', label: 'llama3.1:8b' }
	]
};

export function toModelProvider(value: unknown): ModelProvider {
	if (value === 'anthropic') {
		return 'anthropic';
	}

	if (value === 'ollama') {
		return 'ollama';
	}

	return 'openai';
}

export function defaultModelForProvider(provider: ModelProvider): string {
	if (provider === 'openai') {
		return 'gpt-4o-mini';
	}

	if (provider === 'anthropic') {
		return 'claude-3-5-sonnet-latest';
	}

	if (provider === 'ollama') {
		return 'qwen2.5-coder:7b';
	}

	return 'gpt-4o-mini';
}

export function defaultBaseUrlForProvider(provider: ModelProvider): string {
	if (provider === 'openai') {
		return 'https://api.openai.com/v1';
	}

	if (provider === 'anthropic') {
		return 'https://api.anthropic.com/v1/messages';
	}

	if (provider === 'ollama') {
		return 'http://localhost:11434/api/chat';
	}

	return '';
}
