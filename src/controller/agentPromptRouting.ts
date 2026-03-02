import { type ModelProvider } from '../model/types';

export function isAgentPlannerPrompt(prompt: string): boolean {
	if (!prompt) {
		return false;
	}

	return prompt.includes('Allowed response formats:')
		&& prompt.includes('{"type":"tool_call"')
		&& prompt.includes('You must return strictly one JSON object only');
}

export function shouldUseStructuredPlannerOutput(provider: ModelProvider, prompt: string): boolean {
	if (provider !== 'openai') {
		return false;
	}

	return isAgentPlannerPrompt(prompt);
}
