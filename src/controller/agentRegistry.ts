import * as vscode from 'vscode';
import { defaultModelForProvider, toModelProvider } from '../model/options';
import { type ModelProvider } from '../model/types';

export type AgentDefinition = {
	id: string;
	name: string;
	provider: ModelProvider;
	model: string;
	baseUrl?: string;
	systemPrompt?: string;
	temperature?: number;
	tools?: string[];
	builtin?: boolean;
};

type CustomAgentRecord = {
	id?: unknown;
	name?: unknown;
	provider?: unknown;
	model?: unknown;
	baseUrl?: unknown;
	systemPrompt?: unknown;
	temperature?: unknown;
	tools?: unknown;
};

const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		id: 'enohacker-default',
		name: 'EnoHacker Agent',
		provider: 'openai',
		model: defaultModelForProvider('openai'),
		systemPrompt: 'You are an autonomous coding agent. Plan first, execute in small safe steps, and report progress clearly.',
		tools: ['read', 'search', 'execute', 'todo', 'edit', 'web', 'vscode'],
		builtin: true
	},
	{
		id: 'codex-compatible',
		name: 'Codex Compatible',
		provider: 'openai',
		model: defaultModelForProvider('openai'),
		systemPrompt: 'You are a Codex-style engineering agent. Be concise, tool-driven, and implementation-first.',
		tools: ['read', 'search', 'execute', 'todo', 'edit', 'web', 'vscode'],
		builtin: true
	},
	{
		id: 'claude-code-compatible',
		name: 'Claude Code Compatible',
		provider: 'anthropic',
		model: defaultModelForProvider('anthropic'),
		systemPrompt: 'You are a Claude Code-style engineering agent. Think in steps, make safe edits, and validate results.',
		tools: ['read', 'search', 'execute', 'todo', 'edit', 'web', 'vscode'],
		builtin: true
	}
];

function normalizeTools(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === 'string')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	if (typeof value === 'string') {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	return [];
}

function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('enohacker');
}

function normalizeCustomAgent(input: CustomAgentRecord, index: number): AgentDefinition | undefined {
	const name = String(input.name ?? '').trim();
	const model = String(input.model ?? '').trim();
	if (!name || !model) {
		return undefined;
	}

	const provider = toModelProvider(input.provider);
	const idValue = String(input.id ?? '').trim();
	const safeId = idValue || `custom-agent-${index + 1}-${name.toLowerCase().replace(/\s+/g, '-')}`;
	const baseUrl = String(input.baseUrl ?? '').trim();
	const systemPrompt = String(input.systemPrompt ?? '').trim();
	const rawTemp = Number(input.temperature);
	const temperature = Number.isFinite(rawTemp) ? rawTemp : undefined;
	const tools = normalizeTools(input.tools);

	return {
		id: safeId,
		name,
		provider,
		model,
		baseUrl: baseUrl || undefined,
		systemPrompt: systemPrompt || undefined,
		temperature,
		tools,
		builtin: false
	};
}

export function getCustomAgents(): AgentDefinition[] {
	const raw = getConfig().get<CustomAgentRecord[]>('customAgents', []);
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw
		.map((item, index) => normalizeCustomAgent(item, index))
		.filter((item): item is AgentDefinition => Boolean(item));
}

export function getAvailableAgents(): AgentDefinition[] {
	const customAgents = getCustomAgents();
	const result: AgentDefinition[] = [...BUILTIN_AGENTS];
	const seen = new Set(result.map((item) => item.id));
	for (const item of customAgents) {
		if (seen.has(item.id)) {
			continue;
		}

		seen.add(item.id);
		result.push(item);
	}

	return result;
}

export function getActiveAgentId(): string {
	const configured = getConfig().get<string>('activeAgentId', '').trim();
	if (!configured) {
		return BUILTIN_AGENTS[0].id;
	}

	const exists = getAvailableAgents().some((item) => item.id === configured);
	return exists ? configured : BUILTIN_AGENTS[0].id;
}

export function getActiveAgent(): AgentDefinition {
	const activeId = getActiveAgentId();
	const found = getAvailableAgents().find((item) => item.id === activeId);
	return found ?? BUILTIN_AGENTS[0];
}

export async function setActiveAgentId(agentId: string, target: vscode.ConfigurationTarget): Promise<void> {
	await getConfig().update('activeAgentId', agentId, target);
}

export async function saveCustomAgents(agents: AgentDefinition[], target: vscode.ConfigurationTarget): Promise<void> {
	const payload = agents
		.filter((item) => !item.builtin)
		.map((item) => ({
			id: item.id,
			name: item.name,
			provider: item.provider,
			model: item.model,
			baseUrl: item.baseUrl ?? '',
			systemPrompt: item.systemPrompt ?? '',
			temperature: item.temperature,
			tools: item.tools ?? []
		}));

	await getConfig().update('customAgents', payload, target);
}

export async function addCustomAgent(agent: AgentDefinition, target: vscode.ConfigurationTarget): Promise<void> {
	const all = getAvailableAgents().filter((item) => !item.builtin);
	const next = [
		...all.filter((item) => item.id !== agent.id),
		{ ...agent, builtin: false }
	];
	await saveCustomAgents(next, target);
}

export async function removeCustomAgent(agentId: string, target: vscode.ConfigurationTarget): Promise<void> {
	const all = getAvailableAgents().filter((item) => !item.builtin);
	await saveCustomAgents(all.filter((item) => item.id !== agentId), target);
}
