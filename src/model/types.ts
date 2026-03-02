export type ModelProvider = 'openai' | 'anthropic' | 'ollama';

export type ModelSettings = {
	provider: ModelProvider;
	model: string;
	baseUrl: string;
	apiKey: string;
	temperature: number;
};

export type CustomModelMap = Record<ModelProvider, string[]>;

export type ModelOption = {
	value: string;
	label: string;
};

export type ChatContextKind = 'selection' | 'file' | 'screenshot';

export type ChatContextItem = {
	id: string;
	kind: ChatContextKind;
	label: string;
	content: string;
};

export type ConnectionCheckResult = {
	ok: boolean;
	message: string;
};
