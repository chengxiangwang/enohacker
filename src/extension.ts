import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	CHECK_PROVIDER_COMMAND,
	CONFIGURE_MODEL_COMMAND,
	OPEN_MODEL_MANAGER_COMMAND
} from './controller/constants';
import {
	addCustomAgent,
	getActiveAgent,
	getActiveAgentId,
	getAvailableAgents,
	removeCustomAgent,
	setActiveAgentId,
	type AgentDefinition
} from './controller/agentRegistry';
import { runAgentWithTools } from './controller/agentExecutor';
import { shouldUseStructuredPlannerOutput } from './controller/agentPromptRouting';
import { AgentToolDispatcher, getAgentToolDefinitions, normalizeAgentToolNames } from './controller/agentTools';
import { registerExtensionControllers } from './controller/extensionController';
import {
	defaultBaseUrlForProvider,
	defaultModelForProvider,
	MODEL_OPTIONS,
	toModelProvider
} from './model/options';
import {
	type ChatContextItem,
	type ConnectionCheckResult,
	type CustomModelMap,
	type ModelOption,
	type ModelProvider,
	type ModelSettings
} from './model/types';
import { loadWebviewHtml } from './view/webviewLoader';

type AgentCheckpointFile = {
	relativePath: string;
	existed: boolean;
	contentBase64?: string;
};

type AgentCheckpoint = {
	id: string;
	createdAt: number;
	files: Map<string, AgentCheckpointFile>;
};

type AgentConversationTurn = {
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
};

type ChatSessionState = {
	id: string;
	title: string;
	lastSuggestion: string;
	contextItems: ChatContextItem[];
	agentConversationTurns: AgentConversationTurn[];
	contextCounter: number;
	selectedTools?: string[];
	checkpointCounter: number;
	checkpointHistory: AgentCheckpoint[];
};

type TokenUsageSummary = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	calls: number;
	approximate: boolean;
};

type TokenUsageAccumulator = {
	inputTokens: number;
	outputTokens: number;
	calls: number;
	approximate: boolean;
};

let enoOutputChannel: vscode.OutputChannel | undefined;

class ModelManagerPanel {
	private static currentPanel: ModelManagerPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runProviderConnectionCheck: (showNotification: boolean) => Promise<ConnectionCheckResult>
	) {
		this.panel = vscode.window.createWebviewPanel(
			'enohacker.modelManager',
			'EnoHacker Model Manager',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, localResourceRoots: [extensionUri] }
		);

		this.panel.webview.html = this.getHtml();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(async (message: { type: string; payload?: Record<string, unknown> }) => {
			if (message.type === 'ready') {
				this.postCurrentSettings();
				return;
			}

			if (message.type === 'save' && message.payload) {
				await this.saveSettings(message.payload);
				this.postCurrentSettings();
				return;
			}

			if (message.type === 'providerChanged' && message.payload) {
				const provider = message.payload.provider as ModelProvider | undefined;
				if (provider) {
					this.panel.webview.postMessage({ type: 'modelOptions', options: getModelOptions(provider) });
				}
				return;
			}

			if (message.type === 'check') {
				await this.runProviderConnectionCheck(true);
			}
		}, null, this.disposables);
	}

	public static show(
		extensionUri: vscode.Uri,
		runProviderConnectionCheck: (showNotification: boolean) => Promise<ConnectionCheckResult>
	): void {
		if (ModelManagerPanel.currentPanel) {
			ModelManagerPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
			ModelManagerPanel.currentPanel.postCurrentSettings();
			return;
		}

		ModelManagerPanel.currentPanel = new ModelManagerPanel(extensionUri, runProviderConnectionCheck);
	}

	private async saveSettings(payload: Record<string, unknown>): Promise<void> {
		const provider = toModelProvider(payload.provider);
		const model = String(payload.model ?? '').trim();
		const baseUrl = String(payload.baseUrl ?? '').trim();
		const apiKey = String(payload.apiKey ?? '').trim();
		const temperature = Number(payload.temperature ?? 0.2);
		const scope = String(payload.scope ?? 'workspace');
		const target = resolveConfigurationTarget(scope === 'user' ? 'user' : 'workspace');

		if (!model) {
			vscode.window.showErrorMessage('Model is required.');
			return;
		}

		if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
			vscode.window.showErrorMessage('Temperature must be between 0 and 2.');
			return;
		}

		const config = vscode.workspace.getConfiguration('enohacker');
		await config.update('provider', provider, target);
		await config.update('model', model, target);
		await config.update('baseUrl', baseUrl, target);
		await config.update('temperature', temperature, target);
		await saveCustomModel(provider, model, target);

		if (provider === 'openai' || provider === 'anthropic') {
			if (apiKey) {
				await config.update('apiKey', apiKey, target);
			}
		}

		vscode.window.showInformationMessage(`EnoHacker model saved: ${provider} / ${model}`);
	}

	private postCurrentSettings(): void {
		const settings = getModelSettings();
		this.panel.webview.postMessage({
			type: 'modelConfig',
			settings,
			options: getModelOptions(settings.provider)
		});
	}

	private getHtml(): string {
		return loadWebviewHtml(this.extensionUri, 'model-manager.html');
	}

	private dispose(): void {
		ModelManagerPanel.currentPanel = undefined;
		while (this.disposables.length) {
			const item = this.disposables.pop();
			item?.dispose();
		}
	}
}

class ProviderStatusBarController implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;
	private lastMessage = 'Not checked yet';
	private lastStatus: 'unknown' | 'checking' | 'ok' | 'error' = 'unknown';

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 120);
		this.item.command = CHECK_PROVIDER_COMMAND;
		this.item.show();
		this.render();
	}

	public setChecking(): void {
		this.lastStatus = 'checking';
		this.lastMessage = 'Checking provider connectivity...';
		this.render();
	}

	public setResult(result: ConnectionCheckResult): void {
		this.lastStatus = result.ok ? 'ok' : 'error';
		this.lastMessage = result.message;
		this.render();
	}

	public refreshForConfigChange(): void {
		this.lastStatus = 'unknown';
		this.lastMessage = 'Configuration changed, rechecking...';
		this.render();
	}

	public startAutoRefresh(checkAction: () => Promise<void>): void {
		if (this.timer) {
			clearInterval(this.timer);
		}

		this.timer = setInterval(() => {
			void checkAction();
		}, 120000);

		this.disposables.push(vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) {
				void checkAction();
			}
		}));
	}

	public dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}

		this.item.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private render(): void {
		const settings = getModelSettings();
		const provider = settings.provider;
		const icon = this.lastStatus === 'ok'
			? '$(pass-filled)'
			: this.lastStatus === 'error'
				? '$(error)'
				: this.lastStatus === 'checking'
					? '$(sync~spin)'
					: '$(question)';

		this.item.text = `${icon} EH:${provider}`;
		this.item.tooltip = [
			`Provider: ${provider}`,
			`Model: ${settings.model}`,
			`Status: ${this.lastStatus}`,
			this.lastMessage,
			'Click to run provider connection check.'
		].join('\n');
	}
}

class EnoHackerChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'enohacker.chatView';
	private static readonly checkpointHistoryLimit = 20;
	private static readonly confirmationTimeoutMs = 15000;

	private webviewView?: vscode.WebviewView;
	private lastSuggestion = '';
	private contextItems: ChatContextItem[] = [];
	private contextCounter = 0;
	private activeRequestController: AbortController | undefined;
	private activeRequestId = 0;
	private selectedTools: string[] | undefined;
	private checkpointCounter = 0;
	private pendingCheckpoint: AgentCheckpoint | undefined;
	private checkpointHistory: AgentCheckpoint[] = [];
	private editConfirmCounter = 0;
	private pendingEditConfirmations = new Map<string, (decision: 'keep' | 'cancel') => void>();
	private executeConfirmCounter = 0;
	private pendingExecuteConfirmations = new Map<string, (decision: 'allow' | 'deny') => void>();
	private agentConversationTurns: AgentConversationTurn[] = [];
	private sessionCounter = 0;
	private currentSessionId = '';
	private readonly sessions = new Map<string, ChatSessionState>();

	constructor(private readonly extensionUri: vscode.Uri) {
		const initial = this.createSessionState('Session 1');
		this.sessions.set(initial.id, initial);
		this.currentSessionId = initial.id;
		this.loadSessionState(initial.id);
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.webviewView = webviewView;
		webviewView.title = 'EnoHacker Chat';
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		webviewView.webview.html = this.getHtml();
		webviewView.webview.onDidReceiveMessage(async (message: {
			type: string;
			text?: string;
			model?: string;
			contextId?: string;
			agentId?: string;
			checkpointId?: string;
			sessionId?: string;
			confirmId?: string;
			decision?: string;
			command?: string;
			path?: string;
			summary?: string;
			mode?: string;
			preview?: string;
			fileCount?: number;
			addedLines?: number;
			removedLines?: number;
		}) => {
			if (message.type === 'ready') {
				this.postSessionConfig();
				this.postModelConfig();
				this.postAgentConfig();
				this.postContextItems();
				this.postTokenUsageReset();
			}

			if (message.type === 'newSession') {
				this.saveCurrentSessionState();
				const created = this.createSessionState(`Session ${this.sessionCounter + 1}`);
				this.sessions.set(created.id, created);
				this.switchSession(created.id);
				this.postSessionConfig();
				return;
			}

			if (message.type === 'switchSession' && message.sessionId?.trim()) {
				this.switchSession(message.sessionId.trim());
				this.postSessionConfig();
				return;
			}

			if (message.type === 'agent' && message.text?.trim()) {
				const userQuestion = message.text.trim();
				if (this.activeRequestController) {
					this.activeRequestController.abort();
				}

				const requestId = ++this.activeRequestId;
				const controller = new AbortController();
				this.activeRequestController = controller;

				if (message.agentId?.trim()) {
					await setActiveAgentId(message.agentId.trim(), resolveConfigurationTarget('workspace'));
					this.postAgentConfig();
				}

				this.postTokenUsageReset();
				this.webviewView?.webview.postMessage({ type: 'assistantStart' });

				try {
					const result = await this.answerAgentQuestion(
						userQuestion,
						controller.signal,
						(chunk) => {
							if (requestId !== this.activeRequestId) {
								return;
							}

							this.webviewView?.webview.postMessage({ type: 'assistantChunk', text: chunk });
						}
					);

					if (requestId !== this.activeRequestId) {
						return;
					}

					this.appendAgentConversationTurn('user', userQuestion);
					this.appendAgentConversationTurn('assistant', result.answer);
					this.lastSuggestion = result.answer;
					this.webviewView?.webview.postMessage({ type: 'assistantDone', text: result.answer });
					this.postTokenUsage(result.usage);
				} catch (error) {
					if (requestId !== this.activeRequestId) {
						return;
					}

					const errorText = `请求失败: ${toErrorMessage(error)}`;
					this.lastSuggestion = errorText;
					this.webviewView?.webview.postMessage({ type: 'assistantDone', text: errorText });
					this.postTokenUsageReset();
				} finally {
					if (this.activeRequestController === controller) {
						this.activeRequestController = undefined;
					}
				}
				return;
			}

			if (message.type === 'ask' && message.text?.trim()) {
				if (this.activeRequestController) {
					this.activeRequestController.abort();
				}

				const requestId = ++this.activeRequestId;
				const controller = new AbortController();
				this.activeRequestController = controller;

				const requestedModel = message.model?.trim();
				if (requestedModel) {
					const config = vscode.workspace.getConfiguration('enohacker');
					await config.update('model', requestedModel, resolveConfigurationTarget('workspace'));
				}

				this.postTokenUsageReset();
				this.webviewView?.webview.postMessage({ type: 'assistantStart' });

				try {
					const result = await this.answerQuestion(
						message.text.trim(),
						requestedModel,
						controller.signal,
						(chunk) => {
							if (requestId !== this.activeRequestId) {
								return;
							}

							this.webviewView?.webview.postMessage({ type: 'assistantChunk', text: chunk });
						}
					);
					if (requestId !== this.activeRequestId) {
						return;
					}

					this.lastSuggestion = result.answer;
					this.webviewView?.webview.postMessage({ type: 'assistantDone', text: result.answer });
					this.postTokenUsage(result.usage);
				} catch (error) {
					if (requestId !== this.activeRequestId) {
						return;
					}

					const errorText = `请求失败: ${toErrorMessage(error)}`;
					this.lastSuggestion = errorText;
					this.webviewView?.webview.postMessage({ type: 'assistantDone', text: errorText });
					this.postTokenUsageReset();
				} finally {
					if (this.activeRequestController === controller) {
						this.activeRequestController = undefined;
					}
				}
			}

			if (message.type === 'cancelAsk') {
				if (this.activeRequestController) {
					this.activeRequestController.abort();
					this.resolveAllPendingEditConfirmations('cancel');
					this.resolveAllPendingExecuteConfirmations('deny');
					this.activeRequestController = undefined;
					this.activeRequestId += 1;
					this.webviewView?.webview.postMessage({ type: 'assistantDone', text: '请求已取消。' });
					this.postTokenUsageReset();
				}
			}

			if (message.type === 'editConfirmResponse' && message.confirmId?.trim()) {
				const decision = message.decision === 'cancel' ? 'cancel' : 'keep';
				this.resolveEditConfirmation(message.confirmId.trim(), decision);
			}

			if (message.type === 'executeConfirmResponse' && message.confirmId?.trim()) {
				const decision = message.decision === 'deny' ? 'deny' : 'allow';
				this.resolveExecuteConfirmation(message.confirmId.trim(), decision);
			}

			if (message.type === 'openFileFromConfirm' && message.path?.trim()) {
				await this.openFileFromConfirm(message.path.trim());
			}

			if (message.type === 'setModel' && message.model?.trim()) {
				const config = vscode.workspace.getConfiguration('enohacker');
				await config.update('model', message.model.trim(), resolveConfigurationTarget('workspace'));
				this.postModelConfig();
			}

			if (message.type === 'setAgent' && message.agentId?.trim()) {
				await setActiveAgentId(message.agentId.trim(), resolveConfigurationTarget('workspace'));
				this.selectedTools = undefined;
				this.postAgentConfig();
			}

			if (message.type === 'openToolsManager') {
				await this.openToolsManager();
				this.postAgentConfig();
			}

			if (message.type === 'restoreCheckpoint') {
				await this.restoreCheckpoint(message.checkpointId?.trim());
			}

			if (message.type === 'openAgentManager') {
				await this.openAgentManager();
				this.postAgentConfig();
			}

			if (message.type === 'openModelManager') {
				await vscode.commands.executeCommand(OPEN_MODEL_MANAGER_COMMAND);
			}

			if (message.type === 'addCodeContext') {
				await this.addCodeContext();
			}

			if (message.type === 'addScreenshotContext') {
				await this.addScreenshotContext();
			}

			if (message.type === 'clearContexts') {
				this.contextItems = [];
				this.postContextItems();
			}

			if (message.type === 'removeContext' && message.contextId) {
				this.contextItems = this.contextItems.filter((item) => item.id !== message.contextId);
				this.postContextItems();
			}

			if (message.type === 'insertLastSuggestion') {
				await insertTextToEditor(this.lastSuggestion);
			}
		});
	}

	public notifyConfigChanged(): void {
		this.postModelConfig();
		this.postAgentConfig();
	}

	public revealView(): void {
		if (this.webviewView) {
			this.webviewView.show?.(true);
			return;
		}
		void vscode.commands.executeCommand('enohacker.chatView.focus');
	}

	public async askAndReveal(question: string): Promise<void> {
		this.revealView();
		this.postTokenUsageReset();
		const result = await this.answerQuestion(question);
		this.lastSuggestion = result.answer;
		this.webviewView?.webview.postMessage({ type: 'assistant', text: result.answer });
		this.postTokenUsage(result.usage);
	}

	public getLastSuggestion(): string {
		return this.lastSuggestion;
	}

	private async answerQuestion(
		question: string,
		modelOverride?: string,
		signal?: AbortSignal,
		onChunk?: (chunk: string) => void
	): Promise<{ answer: string; usage: TokenUsageSummary }> {
		const editor = vscode.window.activeTextEditor;
		const contextBlock = editor ? getEditorContext(editor) : 'No active editor context.';
		const managedContext = buildManagedContextBlock(this.contextItems);
		const prompt = `${getSystemPrompt()}\n\nUser question:\n${question}\n\nWorkspace context:\n${contextBlock}\n\nManaged context:\n${managedContext}`;
		const usageAccumulator = createTokenUsageAccumulator();
		const modelSettings = getModelSettings();
		const effectiveModel = modelOverride?.trim() || modelSettings.model;
		logDebug('Ask request start', {
			provider: modelSettings.provider,
			model: effectiveModel,
			baseUrl: modelSettings.baseUrl || '(default)',
			temperature: modelSettings.temperature,
			questionLength: question.length,
			managedContextCount: this.contextItems.length
		});

		const modelOutput = await queryLanguageModel(prompt, effectiveModel, signal, onChunk);
		if (modelOutput) {
			addEstimatedTokenUsage(usageAccumulator, prompt, modelOutput);
			logDebug('Ask request completed', {
				provider: modelSettings.provider,
				model: effectiveModel,
				outputLength: modelOutput.length
			});
			return {
				answer: truncateByLines(modelOutput, getMaxLines()),
				usage: finalizeTokenUsage(usageAccumulator)
			};
		}

		logDebug('Ask request fallback', {
			provider: modelSettings.provider,
			model: effectiveModel
		});
		return {
			answer: truncateByLines(buildFallbackSuggestion(question, editor), getMaxLines()),
			usage: finalizeTokenUsage(usageAccumulator)
		};
	}

	private async answerAgentQuestion(
		question: string,
		signal?: AbortSignal,
		onChunk?: (chunk: string) => void
	): Promise<{ answer: string; usage: TokenUsageSummary }> {
		const activeAgent = getActiveAgent();
		const runtimeSettings = getAgentRuntimeSettings(activeAgent);
		const effectiveTools = this.resolveEffectiveTools(activeAgent);
		const usageAccumulator = createTokenUsageAccumulator();
		this.beginCheckpoint();
		const editor = vscode.window.activeTextEditor;
		const workspaceContext = editor ? getEditorContext(editor) : '暂无活动编辑器上下文。';
		const managedContext = buildManagedContextBlock(this.contextItems);
		const conversationContext = this.buildAgentConversationContext(question);
		const dispatcher = new AgentToolDispatcher({
			onBeforeEdit: (args) => this.captureCheckpointFile(args.path)
		});
		const output = await runAgentWithTools({
			question,
			agentName: activeAgent.name,
			systemPrompt: activeAgent.systemPrompt,
			allowedTools: effectiveTools,
			workspaceContext,
			managedContext,
			conversationContext,
			settings: runtimeSettings,
			signal,
			onChunk,
			onEditApplied: async (payload) => this.requestEditConfirmation(payload),
			onExecuteRequested: async ({ command }) => this.requestExecuteConfirmation(command),
			queryModel: async (prompt, settingsArg, signalArg) => {
				const result = await queryLanguageModelForAgent(prompt, settingsArg, signalArg);
				if (typeof result === 'string' && result.length > 0) {
					addEstimatedTokenUsage(usageAccumulator, prompt, result);
				}

				return result;
			},
			dispatcher
		});
		const checkpoint = this.finalizeCheckpoint();
		if (checkpoint && this.webviewView) {
			this.webviewView.webview.postMessage({
				type: 'checkpointAvailable',
				checkpointId: checkpoint.id,
				fileCount: checkpoint.files.size
			});
		}
		if (output) {
			return {
				answer: truncateByLines(output, getMaxLines()),
				usage: finalizeTokenUsage(usageAccumulator)
			};
		}

		return {
			answer: 'Agent 未返回有效结果。',
			usage: finalizeTokenUsage(usageAccumulator)
		};
	}

	private postTokenUsageReset(): void {
		this.webviewView?.webview.postMessage({ type: 'tokenUsageReset' });
	}

	private postTokenUsage(usage: TokenUsageSummary): void {
		this.webviewView?.webview.postMessage({
			type: 'tokenUsageUpdate',
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			calls: usage.calls,
			approximate: usage.approximate
		});
	}

	private appendAgentConversationTurn(role: 'user' | 'assistant', content: string): void {
		const normalized = content.replace(/\s+/g, ' ').trim();
		if (!normalized) {
			return;
		}

		const clipped = normalized.length > 3000
			? `${normalized.slice(0, 3000)} ...[truncated]`
			: normalized;

		this.agentConversationTurns = [
			...this.agentConversationTurns,
			{ role, content: clipped, createdAt: Date.now() }
		].slice(-48);
	}

	private buildAgentConversationContext(question: string): string {
		if (this.agentConversationTurns.length === 0) {
			return '暂无历史 agent 对话轮次。';
		}

		const recentWindowSize = 6;
		const maxContextChars = 3800;
		const recent = this.agentConversationTurns.slice(-recentWindowSize);
		const older = this.agentConversationTurns.slice(0, Math.max(0, this.agentConversationTurns.length - recentWindowSize));

		const summary = this.buildAgentConversationSummary(older);
		const relevant = this.selectRelevantConversationTurns(older, question, 4);
		const sections: string[] = [];

		if (summary) {
			sections.push('更早对话摘要：\n' + summary);
		}

		if (relevant.length > 0) {
			sections.push(
				'相关历史轮次：\n' + relevant
					.map((turn, index) => `${index + 1}. ${turn.role}: ${turn.content}`)
					.join('\n')
			);
		}

		sections.push(
				'最近轮次：\n' + recent
				.map((turn, index) => `${index + 1}. ${turn.role}: ${turn.content}`)
				.join('\n')
		);

		const context = sections.join('\n\n');
		return context.length > maxContextChars
			? `${context.slice(0, maxContextChars)}\n...[conversation context truncated]`
			: context;
	}

	private buildAgentConversationSummary(turns: AgentConversationTurn[]): string {
		if (turns.length === 0) {
			return '';
		}

		const userPoints = turns
			.filter((turn) => turn.role === 'user')
			.slice(-4)
			.map((turn) => this.compactConversationPoint(turn.content));
		const assistantPoints = turns
			.filter((turn) => turn.role === 'assistant')
			.slice(-4)
			.map((turn) => this.compactConversationPoint(turn.content));

		const lines: string[] = [];
		if (userPoints.length > 0) {
			lines.push('User intents:');
			for (const point of userPoints) {
				lines.push(`- ${point}`);
			}
		}

		if (assistantPoints.length > 0) {
			lines.push('Assistant outcomes:');
			for (const point of assistantPoints) {
				lines.push(`- ${point}`);
			}
		}

		return lines.join('\n');
	}

	private selectRelevantConversationTurns(
		turns: AgentConversationTurn[],
		question: string,
		maxItems: number
	): AgentConversationTurn[] {
		if (turns.length === 0 || maxItems <= 0) {
			return [];
		}

		const keywords = this.extractConversationKeywords(question);
		if (keywords.length === 0) {
			return turns.slice(-Math.min(2, turns.length));
		}

		const scored = turns.map((turn, index) => ({
			turn,
			index,
			score: this.scoreConversationTurn(turn.content, keywords)
		}));

		return scored
			.filter((item) => item.score > 0)
			.sort((a, b) => {
				if (b.score !== a.score) {
					return b.score - a.score;
				}

				return b.index - a.index;
			})
			.slice(0, maxItems)
			.sort((a, b) => a.index - b.index)
			.map((item) => item.turn);
	}

	private extractConversationKeywords(text: string): string[] {
		const normalized = text.toLowerCase();
		const english = normalized.match(/[a-z][a-z0-9_-]{2,}/g) || [];
		const cjk = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
		const unique = new Set<string>();
		for (const token of [...english, ...cjk]) {
			if (token.length >= 2) {
				unique.add(token);
			}
		}

		return [...unique].slice(0, 12);
	}

	private scoreConversationTurn(content: string, keywords: string[]): number {
		const haystack = content.toLowerCase();
		let score = 0;
		for (const keyword of keywords) {
			if (haystack.includes(keyword)) {
				score += keyword.length >= 4 ? 2 : 1;
			}
		}

		return score;
	}

	private compactConversationPoint(text: string): string {
		const compact = text.replace(/\s+/g, ' ').trim();
		if (compact.length <= 110) {
			return compact;
		}

		return `${compact.slice(0, 110)}...`;
	}

	private getHtml(): string {
		return loadWebviewHtml(this.extensionUri, 'chat.html');
	}

	private postModelConfig(): void {
		if (!this.webviewView) {
			return;
		}

		const settings = getModelSettings();
		this.webviewView.webview.postMessage({
			type: 'modelConfig',
			selectedModel: settings.model,
			options: getModelOptions(settings.provider)
		});
	}

	private postSessionConfig(): void {
		if (!this.webviewView) {
			return;
		}

		this.webviewView.webview.postMessage({
			type: 'sessionConfig',
			currentSessionId: this.currentSessionId,
			sessions: [...this.sessions.values()].map((item) => ({
				id: item.id,
				title: item.title
			}))
		});
	}

	private postAgentConfig(): void {
		if (!this.webviewView) {
			return;
		}

		const agents = getAvailableAgents();
		const activeId = getActiveAgentId();
		const activeAgent = getActiveAgent();
		const activeTools = this.resolveEffectiveTools(activeAgent);
		const availableTools = getAgentToolDefinitions().map((item) => ({
			id: item.name,
			label: item.name,
			description: item.description
		}));
		this.webviewView.webview.postMessage({
			type: 'agentConfig',
			selectedAgentId: activeId,
			selectedAgentTools: activeTools,
			selectedTools: activeTools,
			availableTools,
			agents: agents.map((item) => ({
				id: item.id,
				label: item.name,
				description: item.builtin ? 'Use current selected model' : `${item.provider} / ${item.model}`,
				tools: normalizeAgentToolNames(item.tools ?? [])
			}))
		});
	}

	private resolveEffectiveTools(agent: AgentDefinition): string[] {
		if (this.selectedTools && this.selectedTools.length > 0) {
			return [...this.selectedTools];
		}

		return normalizeAgentToolNames(agent.tools ?? []);
	}

	private async openToolsManager(): Promise<void> {
		const activeAgent = getActiveAgent();
		const current = this.resolveEffectiveTools(activeAgent);
		const currentSet = new Set(current);
		const definitions = getAgentToolDefinitions();

		const picks = await vscode.window.showQuickPick(
			definitions.map((item) => ({
				label: item.name,
				description: item.description,
				picked: currentSet.has(item.name)
			})),
			{
				canPickMany: true,
				placeHolder: 'Select tools available to the current agent request'
			}
		);

		if (!picks) {
			return;
		}

		this.selectedTools = picks.map((item) => item.label);
	}

	private beginCheckpoint(): void {
		const id = `cp-${++this.checkpointCounter}`;
		this.pendingCheckpoint = {
			id,
			createdAt: Date.now(),
			files: new Map<string, AgentCheckpointFile>()
		};
	}

	private finalizeCheckpoint(): AgentCheckpoint | undefined {
		const current = this.pendingCheckpoint;
		this.pendingCheckpoint = undefined;
		if (!current || current.files.size === 0) {
			return undefined;
		}

		this.checkpointHistory = [...this.checkpointHistory, current];
		if (this.checkpointHistory.length > EnoHackerChatViewProvider.checkpointHistoryLimit) {
			this.checkpointHistory = this.checkpointHistory.slice(this.checkpointHistory.length - EnoHackerChatViewProvider.checkpointHistoryLimit);
		}
		return current;
	}

	private resolveWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private toCheckpointRelativePath(inputPath: string): string {
		const root = this.resolveWorkspaceRoot();
		if (!root) {
			throw new Error('No workspace folder is open.');
		}

		const absolutePath = path.isAbsolute(inputPath)
			? path.resolve(inputPath)
			: path.resolve(root, inputPath);
		const relative = path.relative(root, absolutePath);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error('Checkpoint path must be inside current workspace.');
		}

		return relative.split(path.sep).join('/');
	}

	private async captureCheckpointFile(inputPath: string): Promise<void> {
		const checkpoint = this.pendingCheckpoint;
		if (!checkpoint) {
			return;
		}

		const relativePath = this.toCheckpointRelativePath(inputPath);
		if (checkpoint.files.has(relativePath)) {
			return;
		}

		const root = this.resolveWorkspaceRoot();
		if (!root) {
			return;
		}

		const absolutePath = path.resolve(root, relativePath);
		const uri = vscode.Uri.file(absolutePath);
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			checkpoint.files.set(relativePath, {
				relativePath,
				existed: true,
				contentBase64: Buffer.from(raw).toString('base64')
			});
		} catch {
			checkpoint.files.set(relativePath, {
				relativePath,
				existed: false
			});
		}
	}

	private async restoreCheckpoint(checkpointId?: string): Promise<void> {
		if (this.checkpointHistory.length === 0) {
			this.webviewView?.webview.postMessage({ type: 'assistant', text: '没有可还原的检查点。' });
			return;
		}

		const targetIndex = checkpointId
			? this.checkpointHistory.findIndex((item) => item.id === checkpointId)
			: this.checkpointHistory.length - 1;
		const checkpoint = targetIndex >= 0 ? this.checkpointHistory[targetIndex] : undefined;
		if (!checkpoint) {
			this.webviewView?.webview.postMessage({ type: 'assistant', text: '检查点不存在或已过期。' });
			return;
		}

		const root = this.resolveWorkspaceRoot();
		if (!root) {
			this.webviewView?.webview.postMessage({ type: 'assistant', text: '当前未打开工作区，无法还原检查点。' });
			return;
		}

		for (const file of checkpoint.files.values()) {
			const absolutePath = path.resolve(root, file.relativePath);
			const uri = vscode.Uri.file(absolutePath);
			if (file.existed) {
				const content = Buffer.from(file.contentBase64 ?? '', 'base64');
				await vscode.workspace.fs.writeFile(uri, content);
				continue;
			}

			try {
				await vscode.workspace.fs.delete(uri);
			} catch {
				continue;
			}
		}

		this.checkpointHistory = this.checkpointHistory.slice(0, targetIndex);
		this.webviewView?.webview.postMessage({
			type: 'checkpointRestored',
			checkpointId: checkpoint.id,
			fileCount: checkpoint.files.size
		});
	}

	private resolveEditConfirmation(confirmId: string, decision: 'keep' | 'cancel'): void {
		const resolver = this.pendingEditConfirmations.get(confirmId);
		if (!resolver) {
			return;
		}

		this.pendingEditConfirmations.delete(confirmId);
		resolver(decision);
	}

	private resolveAllPendingEditConfirmations(decision: 'keep' | 'cancel'): void {
		for (const resolver of this.pendingEditConfirmations.values()) {
			resolver(decision);
		}

		this.pendingEditConfirmations.clear();
	}

	private resolveExecuteConfirmation(confirmId: string, decision: 'allow' | 'deny'): void {
		const resolver = this.pendingExecuteConfirmations.get(confirmId);
		if (!resolver) {
			return;
		}

		this.pendingExecuteConfirmations.delete(confirmId);
		resolver(decision);
	}

	private resolveAllPendingExecuteConfirmations(decision: 'allow' | 'deny'): void {
		for (const resolver of this.pendingExecuteConfirmations.values()) {
			resolver(decision);
		}

		this.pendingExecuteConfirmations.clear();
	}

	private async requestEditConfirmation(payload: {
		path?: string;
		mode?: string;
		summary: string;
		preview?: string;
		fileCount: number;
		files?: Array<{ path: string; mode?: string }>;
	}): Promise<'keep' | 'cancel'> {
		const path = payload.path;
		const lineStats = await this.estimateEditLineStats(path, payload.mode);
		const files = Array.isArray(payload.files) && payload.files.length > 0
			? payload.files
			: (path ? [{ path, mode: payload.mode }] : []);
		const fileEntries: Array<{ path: string; mode?: string; addedLines: number; removedLines: number }> = [];
		for (const item of files) {
			const filePath = String(item.path || '').trim();
			if (!filePath) {
				continue;
			}

			const stats = await this.estimateEditLineStats(filePath, item.mode || payload.mode);
			fileEntries.push({
				path: filePath,
				mode: item.mode,
				addedLines: stats.addedLines,
				removedLines: stats.removedLines
			});
		}
		const webview = this.webviewView?.webview;
		const askNativeEditConfirmation = async (): Promise<'keep' | 'cancel'> => {
			const quickPick = await vscode.window.showInformationMessage(
				path ? `已修改文件 ${path}，是否保留该改动？` : '已执行文件修改，是否保留该改动？',
				'保留',
				'取消'
			);
			return quickPick === '取消' ? 'cancel' : 'keep';
		};

		if (!webview) {
			return askNativeEditConfirmation();
		}

		const confirmId = `edit-confirm-${++this.editConfirmCounter}`;
		const decisionPromise = new Promise<'keep' | 'cancel'>((resolve) => {
			this.pendingEditConfirmations.set(confirmId, resolve);
		});
		webview.postMessage({
			type: 'editConfirmationRequired',
			confirmId,
			path: path || '',
			mode: payload.mode || '',
			summary: payload.summary || '',
			preview: payload.preview || '',
			fileCount: payload.fileCount || 1,
			addedLines: lineStats.addedLines,
			removedLines: lineStats.removedLines,
			files: fileEntries
		});
		const guardedDecision = await Promise.race<('keep' | 'cancel')>([
			decisionPromise,
			new Promise<'keep' | 'cancel'>((resolve) => {
				setTimeout(async () => {
					if (!this.pendingEditConfirmations.has(confirmId)) {
						return;
					}

					this.pendingEditConfirmations.delete(confirmId);
					resolve(await askNativeEditConfirmation());
				}, EnoHackerChatViewProvider.confirmationTimeoutMs);
			})
		]);

		if (guardedDecision === 'cancel') {
			const revertedCount = await this.restorePendingCheckpoint();
			webview.postMessage({
				type: 'editCanceled',
				fileCount: revertedCount
			});
		}

		return guardedDecision;
	}

	private async requestExecuteConfirmation(command: string): Promise<'allow' | 'deny'> {
		const normalizedCommand = String(command || '').trim() || 'pwd';
		const webview = this.webviewView?.webview;
		const askNativeExecuteConfirmation = async (): Promise<'allow' | 'deny'> => {
			const picked = await vscode.window.showInformationMessage(
				`是否允许执行命令：${normalizedCommand}`,
				'允许',
				'不允许'
			);
			return picked === '允许' ? 'allow' : 'deny';
		};

		if (!webview) {
			return askNativeExecuteConfirmation();
		}

		const confirmId = `execute-confirm-${++this.executeConfirmCounter}`;
		const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
			this.pendingExecuteConfirmations.set(confirmId, resolve);
		});
		webview.postMessage({
			type: 'executeConfirmationRequired',
			confirmId,
			command: normalizedCommand
		});
		const guardedDecision = await Promise.race<('allow' | 'deny')>([
			decisionPromise,
			new Promise<'allow' | 'deny'>((resolve) => {
				setTimeout(async () => {
					if (!this.pendingExecuteConfirmations.has(confirmId)) {
						return;
					}

					this.pendingExecuteConfirmations.delete(confirmId);
					resolve(await askNativeExecuteConfirmation());
				}, EnoHackerChatViewProvider.confirmationTimeoutMs);
			})
		]);

		if (guardedDecision === 'deny') {
			webview.postMessage({
				type: 'executeDenied',
				command: normalizedCommand
			});
		}

		return guardedDecision;
	}

	private async restorePendingCheckpoint(): Promise<number> {
		const checkpoint = this.pendingCheckpoint;
		if (!checkpoint || checkpoint.files.size === 0) {
			this.pendingCheckpoint = undefined;
			return 0;
		}

		const root = this.resolveWorkspaceRoot();
		if (!root) {
			this.pendingCheckpoint = undefined;
			return 0;
		}

		for (const file of checkpoint.files.values()) {
			const absolutePath = path.resolve(root, file.relativePath);
			const uri = vscode.Uri.file(absolutePath);
			if (file.existed) {
				const content = Buffer.from(file.contentBase64 ?? '', 'base64');
				await vscode.workspace.fs.writeFile(uri, content);
				continue;
			}

			try {
				await vscode.workspace.fs.delete(uri);
			} catch {
				continue;
			}
		}

		this.pendingCheckpoint = undefined;
		return checkpoint.files.size;
	}

	private async openFileFromConfirm(inputPath: string): Promise<void> {
		const normalized = inputPath.trim();
		if (!normalized) {
			return;
		}

		let filePath = normalized;
		if (!path.isAbsolute(filePath)) {
			const root = this.resolveWorkspaceRoot();
			if (!root) {
				this.webviewView?.webview.postMessage({ type: 'assistant', text: '当前无工作区，无法打开相对路径文件。' });
				return;
			}

			filePath = path.resolve(root, filePath);
		}

		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(document, { preview: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : '未知错误';
			this.webviewView?.webview.postMessage({ type: 'assistant', text: `无法打开文件：${message}` });
		}
	}

	private countLines(text: string): number {
		if (!text) {
			return 0;
		}

		return text.split(/\r?\n/).length;
	}

	private computeLineDelta(beforeText: string, afterText: string): { addedLines: number; removedLines: number } {
		const before = beforeText ? beforeText.split(/\r?\n/) : [];
		const after = afterText ? afterText.split(/\r?\n/) : [];

		let prefix = 0;
		while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
			prefix += 1;
		}

		let suffix = 0;
		while (
			suffix < before.length - prefix
			&& suffix < after.length - prefix
			&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
		) {
			suffix += 1;
		}

		const removedLines = Math.max(0, before.length - prefix - suffix);
		const addedLines = Math.max(0, after.length - prefix - suffix);
		return { addedLines, removedLines };
	}

	private async estimateEditLineStats(pathValue?: string, mode?: string): Promise<{ addedLines: number; removedLines: number }> {
		const inputPath = String(pathValue || '').trim();
		if (!inputPath) {
			return { addedLines: 0, removedLines: 0 };
		}

		const root = this.resolveWorkspaceRoot();
		if (!root) {
			return { addedLines: 0, removedLines: 0 };
		}

		let relativePath = '';
		try {
			relativePath = this.toCheckpointRelativePath(inputPath);
		} catch {
			return { addedLines: 0, removedLines: 0 };
		}

		const checkpoint = this.pendingCheckpoint;
		const beforeEntry = checkpoint?.files.get(relativePath);
		const beforeText = beforeEntry?.existed
			? Buffer.from(beforeEntry.contentBase64 ?? '', 'base64').toString('utf8')
			: '';

		const absolutePath = path.resolve(root, relativePath);
		const uri = vscode.Uri.file(absolutePath);
		let afterText = '';
		try {
			afterText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			afterText = '';
		}

		const normalizedMode = String(mode || '').trim();
		if (normalizedMode === 'create') {
			return { addedLines: this.countLines(afterText), removedLines: 0 };
		}
		if (normalizedMode === 'delete') {
			return { addedLines: 0, removedLines: this.countLines(beforeText) };
		}

		return this.computeLineDelta(beforeText, afterText);
	}

	private createSessionState(title: string): ChatSessionState {
		const id = `session-${++this.sessionCounter}`;
		return {
			id,
			title,
			lastSuggestion: '',
			contextItems: [],
			agentConversationTurns: [],
			contextCounter: 0,
			selectedTools: undefined,
			checkpointCounter: 0,
			checkpointHistory: []
		};
	}

	private saveCurrentSessionState(): void {
		const state = this.sessions.get(this.currentSessionId);
		if (!state) {
			return;
		}

		state.lastSuggestion = this.lastSuggestion;
		state.contextItems = [...this.contextItems];
		state.agentConversationTurns = [...this.agentConversationTurns];
		state.contextCounter = this.contextCounter;
		state.selectedTools = this.selectedTools ? [...this.selectedTools] : undefined;
		state.checkpointCounter = this.checkpointCounter;
		state.checkpointHistory = [...this.checkpointHistory];
	}

	private loadSessionState(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (!state) {
			return;
		}

		this.currentSessionId = state.id;
		this.lastSuggestion = state.lastSuggestion;
		this.contextItems = [...state.contextItems];
		this.agentConversationTurns = [...(state.agentConversationTurns || [])];
		this.contextCounter = state.contextCounter;
		this.selectedTools = state.selectedTools ? [...state.selectedTools] : undefined;
		this.checkpointCounter = state.checkpointCounter;
		this.checkpointHistory = [...state.checkpointHistory];
		this.pendingCheckpoint = undefined;
	}

	private switchSession(sessionId: string): void {
		if (!this.sessions.has(sessionId)) {
			return;
		}

		this.saveCurrentSessionState();
		this.loadSessionState(sessionId);
		this.postModelConfig();
		this.postAgentConfig();
		this.postContextItems();
		this.webviewView?.webview.postMessage({
			type: 'sessionChanged',
			sessionId
		});
	}

	private async openAgentManager(): Promise<void> {
		const action = await vscode.window.showQuickPick(
			[
				{ label: 'Set Active Agent', value: 'set' },
				{ label: 'Add Custom Agent', value: 'add' },
				{ label: 'Remove Custom Agent', value: 'remove' }
			],
			{ placeHolder: 'Configure custom agents' }
		);

		if (!action) {
			return;
		}

		const target = resolveConfigurationTarget('workspace');

		if (action.value === 'set') {
			const agents = getAvailableAgents();
			const pick = await vscode.window.showQuickPick(
				agents.map((item) => ({
					label: item.name,
					description: `${item.provider} / ${item.model}`,
					id: item.id
				})),
				{ placeHolder: 'Select active agent' }
			);

			if (pick?.id) {
				await setActiveAgentId(pick.id, target);
			}
			return;
		}

		if (action.value === 'add') {
			const name = await vscode.window.showInputBox({ prompt: 'Agent name', ignoreFocusOut: true });
			if (!name?.trim()) {
				return;
			}

			const providerPick = await vscode.window.showQuickPick(
				[
					{ label: 'openai', provider: 'openai' as const },
					{ label: 'anthropic', provider: 'anthropic' as const },
					{ label: 'ollama', provider: 'ollama' as const }
				],
				{ placeHolder: 'Select provider for custom agent' }
			);

			if (!providerPick) {
				return;
			}

			const model = await vscode.window.showInputBox({
				prompt: 'Model name',
				value: defaultModelForProvider(providerPick.provider),
				ignoreFocusOut: true
			});

			if (!model?.trim()) {
				return;
			}

			const baseUrl = await vscode.window.showInputBox({
				prompt: 'Base URL (optional)',
				ignoreFocusOut: true
			});

			if (baseUrl === undefined) {
				return;
			}

			const systemPrompt = await vscode.window.showInputBox({
				prompt: 'Agent system prompt (optional)',
				ignoreFocusOut: true
			});

			if (systemPrompt === undefined) {
				return;
			}

			const toolsInput = await vscode.window.showInputBox({
				prompt: 'Agent tools (comma-separated, optional)',
				value: 'read, search, execute, todo, edit, web, vscode',
				ignoreFocusOut: true
			});

			if (toolsInput === undefined) {
				return;
			}

			const tools = toolsInput
				.split(',')
				.map((item) => item.trim())
				.filter((item) => item.length > 0);

			const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await addCustomAgent({
				id,
				name: name.trim(),
				provider: providerPick.provider,
				model: model.trim(),
				baseUrl: baseUrl.trim() || undefined,
				systemPrompt: systemPrompt.trim() || undefined,
				tools,
				builtin: false
			}, target);
			await setActiveAgentId(id, target);
			return;
		}

		const customAgents = getAvailableAgents().filter((item) => !item.builtin);
		if (customAgents.length === 0) {
			vscode.window.showInformationMessage('No custom agents to remove.');
			return;
		}

		const removePick = await vscode.window.showQuickPick(
			customAgents.map((item) => ({
				label: item.name,
				description: `${item.provider} / ${item.model}`,
				id: item.id
			})),
			{ placeHolder: 'Select a custom agent to remove' }
		);

		if (removePick?.id) {
			await removeCustomAgent(removePick.id, target);
			const activeId = getActiveAgentId();
			if (activeId === removePick.id) {
				await setActiveAgentId(getAvailableAgents()[0].id, target);
			}
		}
	}

	private postContextItems(): void {
		if (!this.webviewView) {
			return;
		}

		this.webviewView.webview.postMessage({
			type: 'contextItems',
			items: this.contextItems.map((item) => ({
				id: item.id,
				kind: item.kind,
				label: item.label
			}))
		});
	}

	private async addCodeContext(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const selectedText = editor?.document.getText(editor.selection).trim();
		if (selectedText) {
			this.addSelectionContext();
			return;
		}

		await this.addFileContext();
	}

	private addSelectionContext(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showWarningMessage('No active editor found for adding selection context.');
			return;
		}

		const selectedText = editor.document.getText(editor.selection).trim();
		if (!selectedText) {
			vscode.window.showWarningMessage('Please select code before adding selection context.');
			return;
		}

		const fileLabel = vscode.workspace.asRelativePath(editor.document.uri, false);
		const content = [
			`file: ${fileLabel}`,
			`language: ${editor.document.languageId}`,
			'selectedCode:',
			selectedText
		].join('\n');

		this.contextItems = [
			...this.contextItems,
			{
				id: `ctx-${++this.contextCounter}`,
				kind: 'selection',
				label: `Selection · ${fileLabel}`,
				content: limitContextSize(content)
			}
		];

		this.postContextItems();
	}

	private async addFileContext(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectMany: false,
			canSelectFolders: false,
			title: 'Choose file for chat context'
		});

		if (!picked || picked.length === 0) {
			return;
		}

		const fileUri = picked[0];
		const raw = await vscode.workspace.fs.readFile(fileUri);
		if (looksBinary(raw)) {
			vscode.window.showWarningMessage('Selected file looks binary. Use Screenshot context for images.');
			return;
		}

		const fileText = new TextDecoder().decode(raw);
		const fileLabel = vscode.workspace.asRelativePath(fileUri, false);
		const content = [
			`file: ${fileLabel}`,
			'fileContent:',
			fileText
		].join('\n');

		this.contextItems = [
			...this.contextItems,
			{
				id: `ctx-${++this.contextCounter}`,
				kind: 'file',
				label: `File · ${fileLabel}`,
				content: limitContextSize(content)
			}
		];

		this.postContextItems();
	}

	private async addScreenshotContext(): Promise<void> {
		const { imageUri, temporary } = await captureScreenshotOrPickImage();
		if (!imageUri) {
			return;
		}

		try {
			const raw = await vscode.workspace.fs.readFile(imageUri);
			const maxImageBytes = 800 * 1024;
			if (raw.byteLength > maxImageBytes) {
				vscode.window.showWarningMessage('Screenshot is too large. Please choose an image smaller than 800KB.');
				return;
			}

			const fileLabel = temporary
				? `captured-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
				: vscode.workspace.asRelativePath(imageUri, false);
			const mimeType = getImageMimeType(imageUri);
			const base64 = Buffer.from(raw).toString('base64');
			const content = [
				`imageFile: ${fileLabel}`,
				`mimeType: ${mimeType}`,
				'note: Attached screenshot encoded as base64 for model context.',
				`imageBase64: ${base64}`
			].join('\n');

			this.contextItems = [
				...this.contextItems,
				{
					id: `ctx-${++this.contextCounter}`,
					kind: 'screenshot',
					label: `Screenshot · ${fileLabel}`,
					content: limitContextSize(content)
				}
			];

			this.postContextItems();
		} finally {
			if (temporary) {
				await deleteIfExists(imageUri);
			}
		}
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const chatProvider = new EnoHackerChatViewProvider(context.extensionUri);
	const statusBar = new ProviderStatusBarController();
	enoOutputChannel = vscode.window.createOutputChannel('EnoHacker');

	registerExtensionControllers({
		context,
		extensionUri: context.extensionUri,
		chatViewType: EnoHackerChatViewProvider.viewType,
		chatProvider,
		statusBar,
		outputChannel: enoOutputChannel,
		checkProviderConnection,
		runModelConfigurationWizard,
		openModelManager: ModelManagerPanel.show,
		insertTextToEditor
	});
}

export function deactivate(): void {}

function getSystemPrompt(): string {
	const config = vscode.workspace.getConfiguration('enohacker');
	return config.get<string>('systemPrompt', 'You are EnoHacker, a concise coding assistant.');
}

function getMaxLines(): number {
	const config = vscode.workspace.getConfiguration('enohacker');
	return config.get<number>('maxResponseLines', 120);
}

function isDebugLogsEnabled(): boolean {
	const config = vscode.workspace.getConfiguration('enohacker');
	return config.get<boolean>('enableDebugLogs', false);
}

function logDebug(message: string, meta?: Record<string, unknown>): void {
	if (!isDebugLogsEnabled()) {
		return;
	}

	if (!enoOutputChannel) {
		enoOutputChannel = vscode.window.createOutputChannel('EnoHacker');
	}

	const timestamp = new Date().toISOString();
	if (!meta) {
		enoOutputChannel.appendLine(`[${timestamp}] ${message}`);
		return;
	}

	let serialized = '';
	try {
		serialized = JSON.stringify(meta);
	} catch {
		serialized = '[unserializable metadata]';
	}

	enoOutputChannel.appendLine(`[${timestamp}] ${message} ${serialized}`);
}

function getModelSettings(): ModelSettings {
	const config = vscode.workspace.getConfiguration('enohacker');
	const providerValue = config.get<string>('provider', 'openai');
	return {
		provider: toModelProvider(providerValue),
		model: config.get<string>('model', 'gpt-4o-mini').trim() || 'gpt-4o-mini',
		baseUrl: config.get<string>('baseUrl', '').trim(),
		apiKey: getApiKey(config),
		temperature: config.get<number>('temperature', 0.2)
	};
}

function getApiKey(config: vscode.WorkspaceConfiguration): string {
	const fromEnv = process.env.ENOHACKER_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}

	return config.get<string>('apiKey', '').trim();
}

async function runModelConfigurationWizard(
	runProviderConnectionCheck: (showNotification: boolean) => Promise<ConnectionCheckResult>
): Promise<void> {
	const target = await pickConfigurationTarget();
	if (target === undefined) {
		return;
	}

	const current = getModelSettings();
	const selectedProvider = await pickProvider(current.provider);
	if (!selectedProvider) {
		return;
	}

	const defaultModel = current.model || defaultModelForProvider(selectedProvider);
	const model = await vscode.window.showInputBox({
		prompt: 'Model name',
		value: defaultModel,
		ignoreFocusOut: true,
		placeHolder: defaultModelForProvider(selectedProvider)
	});

	if (!model?.trim()) {
		return;
	}

	const defaultBaseUrl = current.baseUrl || defaultBaseUrlForProvider(selectedProvider);
	const baseUrl = await vscode.window.showInputBox({
		prompt: 'Base URL (optional)',
		value: defaultBaseUrl,
		ignoreFocusOut: true,
		placeHolder: defaultBaseUrlForProvider(selectedProvider)
	});

	if (baseUrl === undefined) {
		return;
	}

	let apiKey = current.apiKey;
	if (selectedProvider === 'openai' || selectedProvider === 'anthropic') {
		const apiKeyInput = await vscode.window.showInputBox({
			prompt: 'API Key (leave empty to keep current value)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: process.env.ENOHACKER_API_KEY ? 'Using ENOHACKER_API_KEY from environment' : 'sk-...'
		});

		if (apiKeyInput === undefined) {
			return;
		}

		if (apiKeyInput.trim()) {
			apiKey = apiKeyInput.trim();
		}
	}

	const temperatureInput = await vscode.window.showInputBox({
		prompt: 'Temperature (0 - 2)',
		value: String(current.temperature),
		ignoreFocusOut: true,
		validateInput: (value) => {
			const parsed = Number(value);
			if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
				return 'Temperature must be a number between 0 and 2';
			}
			return undefined;
		}
	});

	if (temperatureInput === undefined) {
		return;
	}

	const temperature = Number(temperatureInput);
	const config = vscode.workspace.getConfiguration('enohacker');

	await config.update('provider', selectedProvider, target);
	await config.update('model', model.trim(), target);
	await config.update('baseUrl', baseUrl.trim(), target);
	await config.update('temperature', temperature, target);
	await saveCustomModel(selectedProvider, model.trim(), target);

	if (selectedProvider === 'openai' || selectedProvider === 'anthropic') {
		await config.update('apiKey', apiKey, target);
	}

	vscode.window.showInformationMessage(`EnoHacker model configured: ${selectedProvider} / ${model.trim()}`);

	const checkNow = await vscode.window.showQuickPick(['Yes', 'No'], {
		placeHolder: 'Run provider connection check now?'
	});

	if (checkNow === 'Yes') {
		await runProviderConnectionCheck(true);
	}
}

async function pickConfigurationTarget(): Promise<vscode.ConfigurationTarget | undefined> {
	const options: Array<vscode.QuickPickItem & { target: vscode.ConfigurationTarget }> = [
		{
			label: 'User Settings',
			description: 'Apply globally for all projects',
			target: vscode.ConfigurationTarget.Global
		}
	];

	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		options.push({
			label: 'Workspace Settings',
			description: 'Apply only to current workspace',
			target: vscode.ConfigurationTarget.Workspace
		});
	}

	const picked = await vscode.window.showQuickPick(options, {
		placeHolder: 'Choose where to save EnoHacker model settings'
	});

	return picked?.target;
}

function resolveConfigurationTarget(scope: 'user' | 'workspace'): vscode.ConfigurationTarget {
	if (scope === 'user') {
		return vscode.ConfigurationTarget.Global;
	}

	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return vscode.ConfigurationTarget.Global;
	}

	return vscode.ConfigurationTarget.Workspace;
}

async function pickProvider(current: ModelProvider): Promise<ModelProvider | undefined> {
	const options: Array<vscode.QuickPickItem & { provider: ModelProvider }> = [
		{ label: 'openai', description: 'Use OpenAI compatible API', provider: 'openai' },
		{ label: 'anthropic', description: 'Use Anthropic Messages API', provider: 'anthropic' },
		{ label: 'ollama', description: 'Use local Ollama server', provider: 'ollama' }
	];

	const picked = await vscode.window.showQuickPick(options, {
		placeHolder: `Current provider: ${current}`
	});

	return picked?.provider;
}

function getModelOptions(provider: ModelProvider): ModelOption[] {
	const baseOptions = MODEL_OPTIONS[provider] ?? [];
	const customOptions = getCustomModelMap()[provider].map((model) => ({ value: model, label: `${model} (custom)` }));
	const current = getModelSettings().model;
	const mergedBase = mergeModelOptions(baseOptions, customOptions);
	if (!current) {
		return mergedBase;
	}

	if (mergedBase.some((option) => option.value === current)) {
		return mergedBase;
	}

	return [{ value: current, label: `${current} (current)` }, ...mergedBase];
}

function mergeModelOptions(...list: ModelOption[][]): ModelOption[] {
	const result: ModelOption[] = [];
	const seen = new Set<string>();

	for (const options of list) {
		for (const option of options) {
			if (seen.has(option.value)) {
				continue;
			}

			seen.add(option.value);
			result.push(option);
		}
	}

	return result;
}

function getCustomModelMap(): CustomModelMap {
	const config = vscode.workspace.getConfiguration('enohacker');
	const raw = config.get<Record<string, unknown>>('customModels', {});
	return {
		openai: normalizeModelList(raw.openai),
		anthropic: normalizeModelList(raw.anthropic),
		ollama: normalizeModelList(raw.ollama)
	};
}

function normalizeModelList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

async function saveCustomModel(provider: ModelProvider, model: string, target: vscode.ConfigurationTarget): Promise<void> {
	if (!model.trim()) {
		return;
	}

	const map = getCustomModelMap();
	const existsInDefaults = (MODEL_OPTIONS[provider] ?? []).some((option) => option.value === model);
	if (existsInDefaults) {
		return;
	}

	if (map[provider].includes(model)) {
		return;
	}

	map[provider] = [...map[provider], model];
	const config = vscode.workspace.getConfiguration('enohacker');
	await config.update('customModels', map, target);
}

function buildManagedContextBlock(items: ChatContextItem[]): string {
	if (items.length === 0) {
		return 'None.';
	}

	return items
		.map((item, index) => `[#${index + 1}] ${item.label}\n${item.content}`)
		.join('\n\n');
}

function limitContextSize(content: string): string {
	const maxLength = 12000;
	if (content.length <= maxLength) {
		return content;
	}

	return `${content.slice(0, maxLength)}\n\n[truncated: context too long]`;
}

function looksBinary(raw: Uint8Array): boolean {
	const sampleLength = Math.min(raw.length, 2048);
	for (let index = 0; index < sampleLength; index += 1) {
		if (raw[index] === 0) {
			return true;
		}
	}

	return false;
}

function getImageMimeType(uri: vscode.Uri): string {
	const lower = uri.path.toLowerCase();
	if (lower.endsWith('.png')) {
		return 'image/png';
	}

	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
		return 'image/jpeg';
	}

	if (lower.endsWith('.webp')) {
		return 'image/webp';
	}

	if (lower.endsWith('.gif')) {
		return 'image/gif';
	}

	if (lower.endsWith('.bmp')) {
		return 'image/bmp';
	}

	return 'application/octet-stream';
}

async function captureScreenshotOrPickImage(): Promise<{ imageUri?: vscode.Uri; temporary: boolean }> {
	if (process.platform === 'darwin') {
		const captured = await captureInteractiveScreenshotMacOS();
		if (captured.state === 'ok' && captured.imageUri) {
			return { imageUri: captured.imageUri, temporary: true };
		}

		if (captured.state === 'cancelled') {
			return { temporary: false };
		}
	}

	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectMany: false,
		canSelectFolders: false,
		title: 'Choose screenshot/image for chat context',
		filters: {
			Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
		}
	});

	if (!picked || picked.length === 0) {
		return { temporary: false };
	}

	return { imageUri: picked[0], temporary: false };
}

async function captureInteractiveScreenshotMacOS(): Promise<{ state: 'ok'; imageUri: vscode.Uri } | { state: 'cancelled' } | { state: 'failed' }> {
	const outputPath = path.join(
		os.tmpdir(),
		`enohacker-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
	);

	try {
		await runExecFile('screencapture', ['-i', '-x', outputPath]);
	} catch (error) {
		if (isProcessCancelled(error)) {
			return { state: 'cancelled' };
		}

		logDebug('Screenshot capture failed', { error: String(error) });
		vscode.window.showWarningMessage('Failed to capture screenshot. You can choose an image file manually.');
		return { state: 'failed' };
	}

	const uri = vscode.Uri.file(outputPath);
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.size <= 0) {
			return { state: 'cancelled' };
		}
	} catch {
		return { state: 'failed' };
	}

	return { state: 'ok', imageUri: uri };
}

function runExecFile(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(command, args, (error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

function isProcessCancelled(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}

	if ('code' in error && (error as { code?: number }).code === 1) {
		return true;
	}

	if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
		return (error as { message: string }).message.toLowerCase().includes('cancel');
	}

	return false;
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri, { useTrash: false });
	} catch {
		return;
	}
}

function getEditorContext(editor: vscode.TextEditor): string {
	const selection = editor.document.getText(editor.selection).trim();
	const cursorLine = editor.selection.active.line;
	const start = Math.max(0, cursorLine - 12);
	const end = Math.min(editor.document.lineCount - 1, cursorLine + 12);
	const nearby = editor.document.getText(new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length));

	return [
		`file: ${editor.document.fileName}`,
		`language: ${editor.document.languageId}`,
		selection ? `selectedCode:\n${selection}` : 'selectedCode: <empty>',
		`nearbyCode:\n${nearby}`
	].join('\n\n');
}

function getAgentRuntimeSettings(agent: AgentDefinition): ModelSettings {
	const settings = getModelSettings();
	const useCurrentModel = agent.builtin === true;
	return {
		provider: useCurrentModel ? settings.provider : (agent.provider || settings.provider),
		model: useCurrentModel ? settings.model : (agent.model?.trim() || settings.model),
		baseUrl: agent.baseUrl?.trim() || settings.baseUrl,
		apiKey: settings.apiKey,
		temperature: typeof agent.temperature === 'number' ? agent.temperature : settings.temperature
	};
}

async function queryLanguageModel(
	prompt: string,
	modelOverride?: string,
	signal?: AbortSignal,
	onChunk?: (chunk: string) => void
): Promise<string | undefined> {
	const settings = getModelSettings();
	const effectiveSettings: ModelSettings = {
		...settings,
		model: modelOverride?.trim() || settings.model
	};
	return queryLanguageModelBySettings(prompt, effectiveSettings, signal, onChunk);
}

async function queryLanguageModelBySettings(
	prompt: string,
	settings: ModelSettings,
	signal?: AbortSignal,
	onChunk?: (chunk: string) => void
): Promise<string | undefined> {
	if (settings.provider === 'openai') {
		return queryOpenAI(prompt, settings, signal, onChunk);
	}

	if (settings.provider === 'anthropic') {
		return queryAnthropic(prompt, settings, signal);
	}

	return queryOllama(prompt, settings, signal);
}

async function queryLanguageModelForAgent(
	prompt: string,
	settings: ModelSettings,
	signal?: AbortSignal
): Promise<string | undefined> {
	if (!shouldUseStructuredPlannerOutput(settings.provider, prompt)) {
		return queryLanguageModelBySettings(prompt, settings, signal);
	}

	return queryOpenAIForAgentPlanner(prompt, settings, signal);
}

async function queryOpenAIForAgentPlanner(
	prompt: string,
	settings: ModelSettings,
	signal?: AbortSignal
): Promise<string | undefined> {
	if (!settings.apiKey) {
		return 'OpenAI provider selected but no API key found. Set ENOHACKER_API_KEY or enohacker.apiKey.';
	}

	const endpoint = resolveOpenAIChatEndpoint(settings.baseUrl);
	try {
		const response = await fetchWithRetry(endpoint, {
			method: 'POST',
			signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${settings.apiKey}`
			},
			body: JSON.stringify({
				model: settings.model,
				temperature: settings.temperature,
				stream: false,
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: 'agent_step_action',
						strict: true,
						schema: {
							type: 'object',
							oneOf: [
								{
									type: 'object',
									properties: {
										type: { type: 'string', const: 'tool_call' },
										tool: { type: 'string' },
										args: { type: 'object', additionalProperties: true },
										reason: { type: 'string' }
									},
									required: ['type', 'tool'],
									additionalProperties: false
								},
								{
									type: 'object',
									properties: {
										type: { type: 'string', const: 'final' },
										content: { type: 'string' }
									},
									required: ['type', 'content'],
									additionalProperties: false
								}
							]
						}
					}
				},
				messages: [
					{ role: 'user', content: prompt }
				]
			})
		}, signal);

		if (!response.ok) {
			const details = await readErrorDetails(response);
			const lowerDetails = details.toLowerCase();
			const unsupportedStructuredOutput = response.status === 400
				&& (lowerDetails.includes('response_format') || lowerDetails.includes('json_schema'));
			if (unsupportedStructuredOutput) {
				logDebug('Agent planner structured output unsupported, falling back to standard OpenAI call', {
					status: response.status,
					details
				});
				return queryOpenAI(prompt, settings, signal);
			}

			return `OpenAI request failed: ${response.status} ${response.statusText} (endpoint: ${endpoint})${details ? `\n${details}` : ''}`;
		}

		const data = await response.json() as {
			choices?: Array<{ message?: { content?: string } }>;
			model?: string;
		};

		logDebug('OpenAI agent planner response', {
			requestedModel: settings.model,
			actualModel: data.model ?? '(unknown)'
		});

		const content = data.choices?.[0]?.message?.content?.trim();
		return content || undefined;
	} catch (error) {
		if (isAbortError(error)) {
			return '请求已取消。';
		}

		return `OpenAI request error (endpoint: ${endpoint}): ${toErrorMessage(error)}\n网络策略：未设置自定义超时时间；网络错误自动重试 ${NETWORK_RETRY_ATTEMPTS} 次，可点击状态按钮取消。`;
	}
}

async function queryOpenAI(
	prompt: string,
	settings: ModelSettings,
	signal?: AbortSignal,
	onChunk?: (chunk: string) => void
): Promise<string | undefined> {
	if (!settings.apiKey) {
		return 'OpenAI provider selected but no API key found. Set ENOHACKER_API_KEY or enohacker.apiKey.';
	}

	const endpoint = resolveOpenAIChatEndpoint(settings.baseUrl);
	try {
		const response = await fetchWithRetry(endpoint, {
			method: 'POST',
			signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${settings.apiKey}`
			},
			body: JSON.stringify({
				model: settings.model,
				temperature: settings.temperature,
				stream: true,
				messages: [
					{ role: 'user', content: prompt }
				]
			})
		}, signal);

		if (!response.ok) {
			const details = await readErrorDetails(response);
			return `OpenAI request failed: ${response.status} ${response.statusText} (endpoint: ${endpoint})${details ? `\n${details}` : ''}`;
		}

		const streamed = await readOpenAIStreamResponse(response, onChunk);
		logDebug('OpenAI response', {
			requestedModel: settings.model,
			actualModel: streamed.actualModel ?? '(unknown)'
		});

		const content = streamed.content?.trim();
		if (!content) {
			return undefined;
		}

		if (streamed.actualModel && streamed.actualModel !== settings.model) {
			return `⚠️ 你选择的是 ${settings.model}，但服务端实际返回模型是 ${streamed.actualModel}。\n\n${content}`;
		}

		return content;
	} catch (error) {
		if (isAbortError(error)) {
			return '请求已取消。';
		}

		return `OpenAI request error (endpoint: ${endpoint}): ${toErrorMessage(error)}\n网络策略：未设置自定义超时时间；网络错误自动重试 ${NETWORK_RETRY_ATTEMPTS} 次，可点击状态按钮取消。`;
	}
}

async function readOpenAIStreamResponse(
	response: Response,
	onChunk?: (chunk: string) => void
): Promise<{ content: string; actualModel?: string }> {
	if (!response.body) {
		const data = await response.json() as {
			model?: string;
			choices?: Array<{ message?: { content?: string } }>;
		};

		return {
			content: data.choices?.[0]?.message?.content ?? '',
			actualModel: data.model
		};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let content = '';
	let actualModel: string | undefined;

	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const chunks = buffer.split(/\r?\n\r?\n/);
		buffer = chunks.pop() ?? '';

		for (const eventChunk of chunks) {
			const lines = eventChunk.split(/\r?\n/);
			for (const line of lines) {
				if (!line.startsWith('data:')) {
					continue;
				}

				const data = line.slice(5).trim();
				if (!data) {
					continue;
				}

				if (data === '[DONE]') {
					return { content, actualModel };
				}

				try {
					const payload = JSON.parse(data) as {
						model?: string;
						choices?: Array<{ delta?: { content?: string } }>;
					};

					if (payload.model) {
						actualModel = payload.model;
					}

					const delta = payload.choices?.[0]?.delta?.content;
					if (typeof delta === 'string' && delta.length > 0) {
						content += delta;
						onChunk?.(delta);
					}
				} catch {
					continue;
				}
			}
		}
	}

	return { content, actualModel };
}

async function queryAnthropic(prompt: string, settings: ModelSettings, signal?: AbortSignal): Promise<string | undefined> {
	if (!settings.apiKey) {
		return 'Anthropic provider selected but no API key found. Set ENOHACKER_API_KEY or enohacker.apiKey.';
	}

	const endpoint = normalizeUrl(settings.baseUrl, 'https://api.anthropic.com/v1/messages');
	try {
		const response = await fetchWithRetry(endpoint, {
			method: 'POST',
			signal,
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': settings.apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: settings.model || 'claude-3-5-sonnet-latest',
				max_tokens: 1200,
				temperature: settings.temperature,
				messages: [
					{ role: 'user', content: prompt }
				]
			})
		}, signal);

		if (!response.ok) {
			return `Anthropic request failed: ${response.status} ${response.statusText}`;
		}

		const data = await response.json() as {
			content?: Array<{ type?: string; text?: string }>;
		};

		const textParts = (data.content ?? [])
			.filter((item) => item.type === 'text' && typeof item.text === 'string')
			.map((item) => item.text as string);

		return textParts.join('\n').trim() || undefined;
	} catch (error) {
		if (isAbortError(error)) {
			return '请求已取消。';
		}

		return `Anthropic request error: ${toErrorMessage(error)}\n网络策略：未设置自定义超时时间；网络错误自动重试 ${NETWORK_RETRY_ATTEMPTS} 次，可点击状态按钮取消。`;
	}
}

async function queryOllama(prompt: string, settings: ModelSettings, signal?: AbortSignal): Promise<string | undefined> {
	const endpoint = normalizeUrl(settings.baseUrl, 'http://localhost:11434/api/chat');
	try {
		const response = await fetchWithRetry(endpoint, {
			method: 'POST',
			signal,
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: settings.model || 'qwen2.5-coder:7b',
				stream: false,
				options: {
					temperature: settings.temperature
				},
				messages: [
					{ role: 'user', content: prompt }
				]
			})
		}, signal);

		if (!response.ok) {
			return `Ollama request failed: ${response.status} ${response.statusText}`;
		}

		const data = await response.json() as {
			model?: string;
			message?: { content?: string };
		};
		logDebug('Ollama response', {
			requestedModel: settings.model,
			actualModel: data.model ?? '(unknown)'
		});

		const content = data.message?.content?.trim();
		if (!content) {
			return undefined;
		}

		if (data.model && data.model !== settings.model) {
			return `⚠️ 你选择的是 ${settings.model}，但服务端实际返回模型是 ${data.model}。\n\n${content}`;
		}

		return content;
	} catch (error) {
		if (isAbortError(error)) {
			return '请求已取消。';
		}

		return `Ollama request error: ${toErrorMessage(error)}\n网络策略：未设置自定义超时时间；网络错误自动重试 ${NETWORK_RETRY_ATTEMPTS} 次，可点击状态按钮取消。`;
	}
}

function normalizeUrl(value: string, fallback: string): string {
	if (!value.trim()) {
		return fallback;
	}

	return value.trim();
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as NodeJS.ErrnoException & { cause?: unknown }).cause;
		const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : '';
		return `${error.message}${causeMsg}`;
	}

	return 'unknown error';
}

function createTokenUsageAccumulator(): TokenUsageAccumulator {
	return {
		inputTokens: 0,
		outputTokens: 0,
		calls: 0,
		approximate: true
	};
}

function addEstimatedTokenUsage(accumulator: TokenUsageAccumulator, prompt: string, output: string): void {
	accumulator.inputTokens += estimateTokenCount(prompt);
	accumulator.outputTokens += estimateTokenCount(output);
	accumulator.calls += 1;
}

function finalizeTokenUsage(accumulator: TokenUsageAccumulator): TokenUsageSummary {
	const inputTokens = Math.max(0, Math.floor(accumulator.inputTokens));
	const outputTokens = Math.max(0, Math.floor(accumulator.outputTokens));
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		calls: Math.max(0, Math.floor(accumulator.calls)),
		approximate: accumulator.approximate
	};
}

function estimateTokenCount(text: string): number {
	const source = String(text || '');
	if (!source.trim()) {
		return 0;
	}

	let asciiLike = 0;
	let cjk = 0;
	let other = 0;
	for (const char of source) {
		const code = char.codePointAt(0) ?? 0;
		if ((code >= 0x3400 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF)) {
			cjk += 1;
		} else if (code <= 0x7F) {
			asciiLike += 1;
		} else {
			other += 1;
		}
	}

	const estimated = Math.ceil(asciiLike / 4) + cjk + Math.ceil(other / 2);
	return Math.max(1, estimated);
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === 'AbortError') {
		return true;
	}

	if (typeof error === 'object' && error !== null && 'name' in error) {
		return (error as { name?: string }).name === 'AbortError';
	}

	return false;
}

const NETWORK_RETRY_ATTEMPTS = 3;

async function fetchWithRetry(endpoint: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt += 1) {
		if (signal?.aborted) {
			throw new DOMException('Request aborted', 'AbortError');
		}

		try {
			return await fetch(endpoint, init);
		} catch (error) {
			lastError = error;
			if (isAbortError(error) || !isRetryableNetworkError(error) || attempt >= NETWORK_RETRY_ATTEMPTS) {
				throw error;
			}

			await sleepWithAbort(300 * attempt, signal);
		}
	}

	throw lastError ?? new Error('fetch failed');
}

function isRetryableNetworkError(error: unknown): boolean {
	const message = toErrorMessage(error).toLowerCase();
	return (
		message.includes('fetch failed')
		|| message.includes('connect timeout')
		|| message.includes('timed out')
		|| message.includes('etimedout')
		|| message.includes('econnreset')
		|| message.includes('econnrefused')
		|| message.includes('enotfound')
		|| message.includes('eai_again')
	);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Request aborted', 'AbortError'));
			return;
		}

		const timer = setTimeout(() => {
			if (signal) {
				signal.removeEventListener('abort', onAbort);
			}
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Request aborted', 'AbortError'));
		};

		if (signal) {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

async function readErrorDetails(response: Response): Promise<string> {
	try {
		const text = (await response.text()).trim();
		if (!text) {
			return '';
		}

		return text.length > 400 ? `${text.slice(0, 400)}...` : text;
	} catch {
		return '';
	}
}

async function checkProviderConnection(): Promise<ConnectionCheckResult> {
	const settings = getModelSettings();

	if (settings.provider === 'openai') {
		return checkOpenAIConnection(settings);
	}

	if (settings.provider === 'anthropic') {
		return checkAnthropicConnection(settings);
	}

	if (settings.provider === 'ollama') {
		return checkOllamaConnection(settings);
	}

	return checkOpenAIConnection(settings);
}

async function checkOpenAIConnection(settings: ModelSettings): Promise<ConnectionCheckResult> {
	if (!settings.apiKey) {
		return {
			ok: false,
			message: 'Missing API key. Set ENOHACKER_API_KEY or enohacker.apiKey.'
		};
	}

	const endpoint = resolveOpenAIModelsEndpoint(settings.baseUrl);

	try {
		const response = await fetch(endpoint, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${settings.apiKey}`
			}
		});

		if (!response.ok) {
			return {
				ok: false,
				message: `OpenAI endpoint error: ${response.status} ${response.statusText}`
			};
		}

		return {
			ok: true,
			message: `OpenAI reachable (${endpoint}).`
		};
	} catch (error) {
		return {
			ok: false,
			message: `OpenAI request failed: ${toErrorMessage(error)}`
		};
	}
}

function resolveOpenAIChatEndpoint(baseUrl: string): string {
	return resolveOpenAIEndpoint(baseUrl, 'chat/completions');
}

function resolveOpenAIModelsEndpoint(baseUrl: string): string {
	return resolveOpenAIEndpoint(baseUrl, 'models');
}

function resolveOpenAIEndpoint(baseUrl: string, resource: 'chat/completions' | 'models'): string {
	const raw = baseUrl.trim();
	if (!raw) {
		return `https://api.openai.com/v1/${resource}`;
	}

	const normalized = raw.replace(/\/+$/, '');

	if (/\/v\d+\/chat\/completions$/i.test(normalized) || /\/v\d+\/models$/i.test(normalized)) {
		return normalized;
	}

	if (normalized.endsWith('/chat/completions') || normalized.endsWith('/models')) {
		return normalized;
	}

	if (/\/v\d+$/i.test(normalized)) {
		return `${normalized}/${resource}`;
	}

	return `${normalized}/v1/${resource}`;
}

async function checkAnthropicConnection(settings: ModelSettings): Promise<ConnectionCheckResult> {
	if (!settings.apiKey) {
		return {
			ok: false,
			message: 'Missing API key. Set ENOHACKER_API_KEY or enohacker.apiKey.'
		};
	}

	const endpoint = normalizeUrl(settings.baseUrl, 'https://api.anthropic.com/v1/models');

	try {
		const response = await fetch(endpoint, {
			method: 'GET',
			headers: {
				'x-api-key': settings.apiKey,
				'anthropic-version': '2023-06-01'
			}
		});

		if (!response.ok) {
			return {
				ok: false,
				message: `Anthropic endpoint error: ${response.status} ${response.statusText}`
			};
		}

		return {
			ok: true,
			message: `Anthropic reachable (${endpoint}).`
		};
	} catch (error) {
		return {
			ok: false,
			message: `Anthropic request failed: ${toErrorMessage(error)}`
		};
	}
}

async function checkOllamaConnection(settings: ModelSettings): Promise<ConnectionCheckResult> {
	const endpoint = normalizeUrl(settings.baseUrl, 'http://localhost:11434/api/tags');

	try {
		const response = await fetch(endpoint, {
			method: 'GET'
		});

		if (!response.ok) {
			return {
				ok: false,
				message: `Ollama endpoint error: ${response.status} ${response.statusText}`
			};
		}

		return {
			ok: true,
			message: `Ollama reachable (${endpoint}).`
		};
	} catch (error) {
		return {
			ok: false,
			message: `Ollama request failed: ${toErrorMessage(error)}`
		};
	}
}

function buildFallbackSuggestion(question: string, editor: vscode.TextEditor | undefined): string {
	const language = editor?.document.languageId ?? 'text';
	const selectedText = editor ? editor.document.getText(editor.selection).trim() : '';
	const normalizedQuestion = question.trim().toLowerCase();

	if (!selectedText) {
		const isGreeting = /^(hi|hello|hey|你好|您好|嗨|在吗|测试)$/.test(normalizedQuestion);
		if (isGreeting) {
			return [
				'你好，我是 EnoHacker（本地模式）。',
				'我可以帮你：',
				'- 解释代码',
				'- 重构思路',
				'- 生成函数骨架',
				'- 排查报错',
				'',
				'直接发需求即可，例如："给我写一个去重函数（TypeScript）"。'
			].join('\n');
		}

		const isModelQuestion = /模型|你是谁|你是什么|qwen|o1|gpt/.test(normalizedQuestion);
		if (isModelQuestion) {
			return '当前是本地模式，不调用云端大模型。你可以继续让我按规则生成代码建议和重构方案。';
		}

		return [
			`已收到：${question}`,
			'当前为本地模式。若要我更准确地帮助你，请补充：',
			'- 使用语言（如 TypeScript / Python）',
			'- 目标功能',
			'- 输入输出示例（可选）',
			'',
			`本地示例（${language}）：`,
			'```',
			editor?.document.languageId === 'typescript'
				? 'function solve(input: string): string {\n  return input;\n}'
				: 'TODO: implement function body',
			'```'
		].join('\n');
	}

	return [
		'已基于你当前选中代码进入本地分析模式。',
		`问题：${question}`,
		'',
		'```',
		selectedText,
		'```',
		'',
		'建议下一步：',
		'- 明确期望行为与边界条件',
		'- 抽离小函数并减少副作用',
		'- 为关键分支补最小测试用例',
		'- 最后执行 formatter 和 lint'
	].join('\n');
}

async function insertTextToEditor(text: string): Promise<void> {
	if (!text.trim()) {
		vscode.window.showWarningMessage('No suggestion available to insert yet.');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor found for insertion.');
		return;
	}

	await editor.edit((builder) => {
		if (!editor.selection.isEmpty) {
			builder.replace(editor.selection, text);
			return;
		}

		builder.insert(editor.selection.active, text);
	});
}

function truncateByLines(value: string, maxLines: number): string {
	const lines = value.split(/\r?\n/);
	if (lines.length <= maxLines) {
		return value;
	}

	return `${lines.slice(0, maxLines).join('\n')}\n...\n[trimmed to ${maxLines} lines]`;
}
