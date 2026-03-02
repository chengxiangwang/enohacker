import * as assert from 'assert';
import { isAgentPlannerPrompt, shouldUseStructuredPlannerOutput } from '../controller/agentPromptRouting';

suite('Agent Prompt Routing', () => {
	test('recognizes planner prompt shape', () => {
		const plannerPrompt = [
			'You are an autonomous coding agent.',
			'You must return strictly one JSON object only, no markdown.',
			'Allowed response formats:',
			'{"type":"tool_call","tool":"<name>","args":{...}}'
		].join('\n');

		assert.strictEqual(isAgentPlannerPrompt(plannerPrompt), true);
	});

	test('does not classify normal ask prompt as planner prompt', () => {
		const askPrompt = [
			'You are EnoHacker, a concise coding assistant.',
			'User question:',
			'Please explain this function and suggest improvements.'
		].join('\n');

		assert.strictEqual(isAgentPlannerPrompt(askPrompt), false);
	});

	test('structured planner output only enabled for openai + planner prompt', () => {
		const plannerPrompt = [
			'You must return strictly one JSON object only',
			'Allowed response formats:',
			'{"type":"tool_call","tool":"<name>","args":{...}}'
		].join('\n');

		assert.strictEqual(shouldUseStructuredPlannerOutput('openai', plannerPrompt), true);
		assert.strictEqual(shouldUseStructuredPlannerOutput('anthropic', plannerPrompt), false);
		assert.strictEqual(shouldUseStructuredPlannerOutput('ollama', plannerPrompt), false);
		assert.strictEqual(
			shouldUseStructuredPlannerOutput('openai', 'normal ask question with workspace context'),
			false
		);
	});
});
