import { type ModelSettings } from '../model/types';
import { AgentToolDispatcher, getAgentToolDefinitions } from './agentTools';

type AgentExecutionInput = {
	question: string;
	agentName: string;
	systemPrompt?: string;
	allowedTools: string[];
	workspaceContext: string;
	managedContext: string;
	conversationContext?: string;
	settings: ModelSettings;
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
	onEditApplied?: (payload: {
		step: number;
		path?: string;
		mode?: string;
		summary: string;
		preview?: string;
		fileCount: number;
		files?: Array<{ path: string; mode?: string }>;
	}) => Promise<'keep' | 'cancel'>;
	onExecuteRequested?: (payload: { step: number; command: string }) => Promise<'allow' | 'deny'>;
	queryModel: (prompt: string, settings: ModelSettings, signal?: AbortSignal) => Promise<string | undefined>;
	maxSteps?: number;
	dispatcher?: AgentToolDispatcher;
};

type AgentStepAction =
	| { type: 'tool_call'; tool: string; args?: Record<string, unknown>; reason?: string }
	| { type: 'final'; content: string };

function canonicalizePlannedToolName(rawTool: string): string {
	const value = String(rawTool || '').trim().toLowerCase();
	if (!value) {
		return value;
	}

	if (value === 'search' || value === 'codebase.search' || value === 'textsearch' || value === 'filesearch') {
		return 'search';
	}

	if (value === 'read' || value === 'codebase.read' || value === 'readfile' || value === 'read_file') {
		return 'read';
	}

	if (value === 'edit' || value === 'code.edit' || value === 'editfiles' || value === 'applypatch') {
		return 'edit';
	}

	if (value === 'execute' || value === 'terminal.run' || value === 'runinterminal' || value === 'run_in_terminal') {
		return 'execute';
	}

	if (value === 'todo' || value === 'todos' || value === 'manage_todo_list') {
		return 'todo';
	}

	if (value === 'web' || value === 'fetch' || value === 'fetch_webpage') {
		return 'web';
	}

	if (value === 'vscode' || value === 'runvscodecommand' || value === 'run_vscode_command' || value === 'problems') {
		return 'vscode';
	}

	return value;
}

function buildFallbackToolCall(question: string, allowedTools: string[]): { tool: string; args: Record<string, unknown> } | undefined {
	if (allowedTools.length === 0) {
		return undefined;
	}

	const preferred = allowedTools.includes('search')
		? 'search'
		: allowedTools.includes('vscode')
				? 'vscode'
				: allowedTools.includes('read')
					? 'read'
				: allowedTools.includes('todo')
					? 'todo'
					: allowedTools[0];

	if (preferred === 'search') {
		const compactQuery = question
			.replace(/\s+/g, ' ')
			.trim()
			.split(' ')
			.slice(0, 10)
			.join(' ');
		return {
			tool: 'search',
			args: {
				query: compactQuery || question,
				scope: 'text',
				recursive: true,
				maxResults: 10
			}
		};
	}

	if (preferred === 'read') {
		return {
			tool: 'read',
			args: {
				action: 'activeEditor',
				startLine: 1,
				endLine: 220
			}
		};
	}

	if (preferred === 'vscode') {
		return {
			tool: 'vscode',
			args: {
				action: 'context'
			}
		};
	}

	if (preferred === 'todo') {
		return {
			tool: 'todo',
			args: {
				action: 'list'
			}
		};
	}

	if (preferred === 'execute') {
		return {
			tool: 'execute',
			args: {
				command: 'pwd'
			}
		};
	}

	if (preferred === 'web') {
		const url = extractFirstUrl(question);
		if (!url) {
			return undefined;
		}

		return {
			tool: 'web',
			args: {
				url
			}
		};
	}

	return {
		tool: preferred,
		args: {}
	};
}

function buildLoopBreakToolCall(
	question: string,
	allowedTools: string[],
	avoidTool?: string,
	options?: { preferFileSearch?: boolean }
): { tool: string; args: Record<string, unknown> } | undefined {
	const candidates = allowedTools.filter((tool) => tool !== avoidTool);
	if (candidates.length === 0) {
		return undefined;
	}

	if (candidates.includes('search')) {
		return {
			tool: 'search',
			args: {
				query: compactQuestionQuery(question),
				scope: options?.preferFileSearch ? 'files' : 'text',
				recursive: true,
				maxResults: 10
			}
		};
	}

	if (candidates.includes('vscode')) {
		return {
			tool: 'vscode',
			args: {
				action: 'context'
			}
		};
	}

	if (candidates.includes('read')) {
		return {
			tool: 'read',
			args: {
				action: 'activeEditor',
				startLine: 1,
				endLine: 220
			}
		};
	}

	if (candidates.includes('todo')) {
		return {
			tool: 'todo',
			args: {
				action: 'list'
			}
		};
	}

	const first = candidates[0];
	if (first === 'web') {
		const url = extractFirstUrl(question);
		if (url) {
			return {
				tool: 'web',
				args: {
					url
				}
			};
		}

		return undefined;
	}

	return {
		tool: first,
		args: first === 'execute'
			? { command: 'pwd' }
			: {}
	};
}

function compactQuestionQuery(question: string): string {
	const compactQuery = question
		.replace(/\s+/g, ' ')
		.trim()
		.split(' ')
		.slice(0, 10)
		.join(' ');

	return compactQuery || question;
}

function detectTaskProfile(question: string): 'implementation' | 'debugging' | 'analysis' {
	const text = String(question || '').toLowerCase();

	if (/\b(create|implement|develop|build|write|add|generate|scaffold|script)\b|创建|实现|开发|编写|新增|生成|脚本/.test(text)) {
		return 'implementation';
	}

	if (/\b(fix|debug|error|bug|failing|failure|broken|issue|trace)\b|修复|报错|错误|故障|失败|异常/.test(text)) {
		return 'debugging';
	}

	return 'analysis';
}

function buildTaskProfileGuidance(question: string, allowedTools: string[]): string {
	const profile = detectTaskProfile(question);
	const hasTodo = allowedTools.includes('todo');
	const hasEdit = allowedTools.includes('edit');
	const hasExecute = allowedTools.includes('execute');
	const hasReadOrSearch = allowedTools.includes('read') || allowedTools.includes('search') || allowedTools.includes('vscode');
	const completionHints: string[] = [];

	if (profile === 'implementation') {
		completionHints.push('这是 IMPLEMENTATION（实现类）请求：成功标准是产出工作区中的具体交付物，而不只是分析。');
		if (hasTodo) {
			completionHints.push('先用 todo(plan) 定义交付物与验收标准；每个关键动作前使用 todo(next)。');
		}
		if (hasReadOrSearch) {
			completionHints.push('用最小证据（read/search/vscode）定位目标文件，或确定新文件路径。');
		}
		if (hasEdit) {
			completionHints.push('在给出 final 前，至少执行一次 edit 来创建或修改所需文件内容。');
		} else {
			completionHints.push('若无 edit 工具，需明确说明限制，并给出可执行的替代输出。');
		}
		if (hasExecute) {
			completionHints.push('若允许 execute，长任务在 final 前必须至少触发一次 execute tool_call 进行验证（即使会进入用户确认）。');
			completionHints.push('若出现“进展总结/下一步计划”但缺少验证证据，不要 final，优先进入 execute。');
		}
		completionHints.push('除非用户明确只要规划，否则不要在仅做了 plan/search/read 后直接 final。');
	}

	if (profile === 'debugging') {
		completionHints.push('这是 DEBUGGING（排障类）请求：优先复现/定位错误，再做针对性修复与验证。');
		if (hasTodo) {
			completionHints.push('使用 todo 跟踪：复现 -> 根因 -> 修复 -> 验证证据。');
		}
		if (hasExecute) {
			completionHints.push('若允许 execute，在 final 前至少触发一次 execute 以拿到验证证据；不要只输出排障计划。');
		}
	}

	if (profile === 'analysis') {
		completionHints.push('这是 ANALYSIS（分析类）请求：优先保证证据质量与结论简洁性。');
	}

	completionHints.push('每次 tool_call 都必须提供可直接执行的具体 args（禁止占位符）。');

	return [`任务画像：${profile.toUpperCase()}`, ...completionHints.map((item) => `- ${item}`)].join('\n');
}

function inferExecuteCommand(question: string): string {
	const text = String(question || '').toLowerCase();
	if (/\b(test|tests|validate|verification)\b|测试|验证/.test(text)) {
		return 'npm test';
	}

	if (/\b(lint|eslint|format|prettier)\b|代码规范|格式化/.test(text)) {
		return 'npm run lint';
	}

	if (/\b(build|compile|bundle)\b|编译|构建/.test(text)) {
		return 'npm run build';
	}

	if (/\b(run|start|dev|serve)\b|运行|启动/.test(text)) {
		return 'npm run dev';
	}

	if (/\b(implement|fix|refactor|create|develop)\b|实现|修复|重构|开发/.test(text)) {
		return 'npm run compile';
	}

	return 'pwd';
}

function extractFirstUrl(text: string): string | undefined {
	const match = String(text || '').match(/https?:\/\/[^\s"'`<>]+/i);
	return match?.[0];
}

function extractFilePathFromWorkspaceContext(workspaceContext: string): string | undefined {
	const matched = String(workspaceContext || '').match(/^file:\s*(.+)$/mi);
	if (!matched?.[1]) {
		return undefined;
	}

	const value = matched[1].trim();
	return value || undefined;
}

function normalizePlannedToolArgs(
	toolName: string,
	rawArgs: Record<string, unknown> | undefined,
	question: string,
	workspaceContext: string
): Record<string, unknown> {
	const args: Record<string, unknown> = { ...(rawArgs || {}) };

	if (toolName === 'search') {
		const query = String(args.query ?? '').trim();
		if (!query) {
			args.query = compactQuestionQuery(question);
		}

		if (args.scope === undefined) {
			args.scope = 'text';
		}

		if (args.maxResults === undefined) {
			args.maxResults = 10;
		}

		if (args.recursive === undefined) {
			args.recursive = true;
		}
	}

	if (toolName === 'read') {
		const action = String(args.action ?? '').trim();
		const path = String(args.path ?? '').trim();
		if (!action && !path) {
			args.action = 'activeEditor';
			if (args.startLine === undefined) {
				args.startLine = 1;
			}
			if (args.endLine === undefined) {
				args.endLine = 220;
			}
		}
	}

	if (toolName === 'todo') {
		if (args.action === undefined) {
			args.action = 'list';
		}
	}

	if (toolName === 'vscode') {
		if (args.action === undefined) {
			args.action = 'context';
		}
	}

	if (toolName === 'execute') {
		const command = String(args.command ?? '').trim();
		if (!command) {
			args.command = inferExecuteCommand(question);
		}
	}

	if (toolName === 'web') {
		const url = String(args.url ?? '').trim();
		if (!url) {
			const inferredUrl = extractFirstUrl(question);
			if (inferredUrl) {
				args.url = inferredUrl;
			}
		}
	}

	if (toolName === 'edit') {
		const inputPath = String(args.path ?? '').trim();
		if (!inputPath) {
			const inferredPath = extractFilePathFromWorkspaceContext(workspaceContext);
			if (inferredPath) {
				args.path = inferredPath;
			}
		}
	}

	return args;
}

function isEmptySearchResult(result: { summary: string; data?: unknown }): boolean {
	if (Array.isArray(result.data)) {
		return result.data.length === 0;
	}

	return /found\s+0\s+match/i.test(String(result.summary || ''));
}

function isNonProgressToolResult(toolName: string, result: { ok: boolean; summary: string; data?: unknown }): boolean {
	if (!result.ok) {
		return true;
	}

	if (toolName === 'search' && isEmptySearchResult(result)) {
		return true;
	}

	if (toolName === 'vscode') {
		if (isNoActiveEditorContextResult(result)) {
			return true;
		}
	}

	return false;
}

function isNoActiveEditorContextResult(result: { summary: string; data?: unknown }): boolean {
	const summary = String(result.summary || '').toLowerCase();
	return summary.includes('no active editor context');
}

function clipString(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function formatJsonInline(value: unknown, maxChars: number): string {
	const serialized = JSON.stringify(value ?? {});
	if (!serialized) {
		return '{}';
	}

	return clipString(serialized, maxChars);
}

function summarizeToolResult(result: { ok: boolean; summary: string; data?: unknown }): string {
	const marker = result.ok ? '✅' : '❌';
	const dataPreview = result.data === undefined
		? ''
		: `\n  - data: \`${formatJsonInline(result.data, 320)}\``;
	return `${marker} ${result.summary}${dataPreview}`;
}

function emitStepRecord(
	onChunk: ((chunk: string) => void) | undefined,
	step: number,
	action: string,
	observation: string
): void {
	let label = 'trace';
	try {
		const parsed = JSON.parse(action) as { type?: unknown; tool?: unknown };
		if (parsed.type === 'tool_call' && typeof parsed.tool === 'string' && parsed.tool.trim().length > 0) {
			label = `tool_call(${parsed.tool.trim()})`;
		} else if (parsed.type === 'final') {
			label = 'final';
		}
	} catch {
		label = 'trace';
	}

	onChunk?.(`- step ${step}: ${label}\n`);
	onChunk?.(`  - action: \`${formatJsonInline(action, 220)}\`\n`);
	onChunk?.(`  - observation: \`${formatJsonInline(observation, 220)}\`\n\n`);
}

function parseStepAction(rawOutput: string): AgentStepAction | undefined {
	const trimmed = rawOutput.trim();
	if (!trimmed) {
		return undefined;
	}

	let candidate = trimmed;
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		candidate = fenced[1].trim();
	}

	try {
		const parsed = JSON.parse(candidate) as Record<string, unknown>;
		if (parsed.type === 'tool_call' && typeof parsed.tool === 'string') {
			return {
				type: 'tool_call',
				tool: parsed.tool,
				args: (parsed.args ?? {}) as Record<string, unknown>,
				reason: typeof parsed.reason === 'string' ? parsed.reason : undefined
			};
		}

		if (parsed.type === 'final' && typeof parsed.content === 'string') {
			return {
				type: 'final',
				content: parsed.content
			};
		}
	} catch {
		return undefined;
	}

	return undefined;
}

function buildToolCatalog(allowedTools: string[]): string {
	const allowedSet = new Set(allowedTools);
	return getAgentToolDefinitions()
		.filter((tool) => allowedSet.has(tool.name))
		.map((tool) => `- ${tool.name}: ${tool.description}\n  输入: ${tool.inputSchema}`)
		.join('\n');
}

function resolveMaxSteps(question: string, requestedMaxSteps?: number): number {
	if (typeof requestedMaxSteps === 'number' && Number.isFinite(requestedMaxSteps)) {
		return Math.max(1, Math.floor(requestedMaxSteps));
	}

	return Number.MAX_SAFE_INTEGER;
}

function buildPlannerPrompt(
	input: AgentExecutionInput,
	toolCatalog: string,
	history: Array<{ step: number; action: string; observation: string }>
): string {
	const taskProfileGuidance = buildTaskProfileGuidance(input.question, input.allowedTools || []);
	const historyText = history.length === 0
		? '暂无历史步骤。'
		: history.map((item) => `步骤 ${item.step}\n动作: ${item.action}\n观察:\n${item.observation}`).join('\n\n');

	const toolPlaybook = [
		'工具使用手册（用于正确选工具）：',
		'- read：编辑前读取一个或多个文件；当前焦点可使用 activeEditor。',
		'- search：在 read/edit 前先定位候选文件或符号；找文件名时使用 scope="files"；默认 recursive=true 递归搜索子目录。',
		'- edit：已有文件应在 read/search 取证后再改；新建文件在路径和交付物明确后可直接 edit。',
		'- execute：运行 build/test/lint 等命令验证改动，优先小范围命令。',
		'- vscode：使用 problems/context/openFile 获取 IDE 状态与诊断信息。',
		'- web：仅当本地工作区信息不足时再抓取外部文档。',
		'- todo：用结构化任务、依赖与验收标准跟踪和细化计划。',
		'',
		taskProfileGuidance,
		'',
		'规划协议（每次选工具前都执行）：',
		'1) 识别用户目标、约束与期望输出',
		'2) 用一句短语重述“当前下一步交付物”（如“创建 bash 文件”“修补解析器”“运行测试”）',
		'3) 判断缺失信息，选择最能降低不确定性的工具',
		'4) 多步骤任务需维护可衡量验收标准的 todo',
		'5) 每次工具返回后更新 todo 状态，并决定最小下一步动作',
		'',
		'默认策略：',
		'1) 面对复杂目标先 todo(plan)，再用 todo(next) 选出可执行项',
		'2) 用 search/read/vscode(context|problems) 为当前 todo 项取证',
		'3) 用 edit 实施该项的最小安全改动',
		'4) 用 execute 做验证（tests/lint/build），并在 todo(update) 记录证据',
		'5) 出现失败时，基于输出做有针对性的 read/edit/execute 迭代',
		'6) 仅在 todo 完成或明确阻塞时才返回 final',
		'7) 禁止把“当前进展总结/下一步计划”当作完成结果；这类内容应继续 tool_call 推进，而不是 final',
		'8) 除非用户明确要求暂停，否则禁止向用户询问“是否继续执行/是否继续创建文件”等流程性确认',
		'9) 当出现 non-progress 迹象时，下一步必须是可执行动作（search/read/edit/execute 之一），禁止再次输出阶段总结。',
		'',
		'execute 使用策略：',
		'- 前期验证优先单命令 execute（一次只做一件事），提升可观测性与可中断性。',
		'- 仅在临近最终验收时，才可合并多个验证命令（或调用统一验证脚本）。',
		'- 若上一步失败且无新改动，不要重复同一验证命令。',
		'- 对长耗时命令，优先先跑小范围验证，再决定是否全量验证。',
		'- 若任务仍处于“进展总结/下一步计划”阶段且未验证，不要 final，下一步优先 execute（会触发命令确认也算进入验证阶段）。',
		'- 若连续出现非进展观察（空结果/上下文无变化），禁止直接总结收尾；应切换到更有增量的工具，优先 execute 或 edit。',
		'- 当允许 execute 且任务目标包含实现/修复/验证时，final 前必须至少发起一次 execute tool_call（由系统处理确认）。',
		'- search 在实现/排障场景默认使用 recursive=true；若 includePattern 过窄导致 0 命中，应放宽 includePattern 或切换 scope。',
		'',
		'动作质量检查清单（内部）：',
		'- 这次 tool_call 是否是推进当前交付物的最小动作？',
		'- args 是否完整、可立即执行？',
		'- 若上一步无进展，这一步是否有实质差异？',
		'- 实现类任务在 final 前是否至少发生过一次具体 edit？',
		'',
		'安全规则：',
		'- 编辑已有文件前先 read/search 相关内容；创建新文件可在路径与内容目标明确后执行。',
		'- execute 命令保持小范围且非破坏性。',
		'- 工具失败后优先重规划并修正 args，避免重复同样失败调用。',
		'- search 返回 0 命中时，不要重复同一参数；改 query/scope 或用 read/vscode 取证。',
		'- 在空结果或失败后，不要连续两次调用完全相同的 tool+args。',
		'- 只有能说明“改了什么”和“验证状态”时才 final；若未改动需明确原因。',
		'- 面对宽泛需求优先使用 todo(plan/add/update/next)，不要陷入临时搜索循环。'
	].join('\n');

	return [
		input.systemPrompt || '你是一个自主编码代理。需要时优先使用工具，并保持操作安全。',
		'',
		`Agent: ${input.agentName}`,
		'你必须严格只返回一个 JSON 对象，禁止 markdown。',
		'允许的响应格式：',
		'{"type":"tool_call","tool":"<name>","args":{...},"reason":"可选"}',
		'{"type":"final","content":"面向用户的最终回复"}',
		'',
		'输出约束：',
		'- tool_call 必须包含可立即执行的具体 args。',
		'- reason 保持简短且面向行动。',
		'- 单次响应禁止输出多个动作。',
		'- 禁止输出“请确认是否继续执行”这类用户交互话术；需要继续时直接返回下一步 tool_call。',
		'- 若上一步观察为 non-progress，优先返回能产生增量证据的 tool_call；仅在已满足完成条件或存在明确阻塞时才返回 final。',
		'',
		'规则：',
		'- 只能使用下方列出的工具。',
		'- 每一步最多调用一个工具。',
		'- 当信息充分时返回 final。',
		'',
		'可用工具：',
		toolCatalog || '(无)',
		'',
		toolPlaybook,
		'',
		'用户目标：',
		input.question,
		'',
		'工作区上下文：',
		clipString(input.workspaceContext, 2500),
		'',
		'托管上下文：',
		clipString(input.managedContext, 2500),
		'',
		'会话上下文：',
		clipString(input.conversationContext || '暂无历史对话轮次。', 2500),
		'',
		'历史步骤与观察：',
		historyText
	].join('\n');
}

function buildFinalPrompt(
	input: AgentExecutionInput,
	history: Array<{ step: number; action: string; observation: string }>,
	options?: { nonProgressLoopBreak?: boolean }
): string {
	const historyText = history.length === 0
		? '尚未发生工具调用。'
		: history.map((item) => `步骤 ${item.step}\n动作: ${item.action}\n观察:\n${item.observation}`).join('\n\n');
	const nonProgressGuard = options?.nonProgressLoopBreak
		? [
			'检测到此前存在连续 non-progress 观察：',
			'- 禁止把“当前进展总结/下一步计划”包装成完成结果。',
			'- 禁止输出“请确认是否继续执行”；若可继续，应直接给出下一次可执行动作。',
			'- 若仍未满足完成条件，请明确缺失证据与下一步建议（优先 execute 验证）。',
			''
		].join('\n')
		: '';

	return [
		input.systemPrompt || '你是一个自主编码代理。',
		'',
		'请基于工具观察与用户目标，生成给用户的最终回复。',
		'不要输出 JSON；请输出简洁 markdown，包含关键结论与下一步。',
		'禁止反问用户“是否继续执行”或“是否确认下一步”；只有在用户明确要求暂停/选择时才提出问题。',
		'若观察显示仅有阶段性进展总结而缺少关键验证证据，请明确说明尚未完成原因与下一次可执行动作，不要伪装成完成。',
		nonProgressGuard,
		'',
		'用户目标：',
		input.question,
		'',
		'会话上下文：',
		clipString(input.conversationContext || '暂无历史对话轮次。', 2500),
		'',
		'工具观察：',
		historyText
	].join('\n');
}

export async function runAgentWithTools(input: AgentExecutionInput): Promise<string> {
	const maxSteps = resolveMaxSteps(input.question, input.maxSteps);
	const allowedTools = (input.allowedTools || []).filter((item) => item.trim().length > 0);
	const allowedSet = new Set(allowedTools);
	const toolCatalog = buildToolCatalog(allowedTools);
	const dispatcher = input.dispatcher ?? new AgentToolDispatcher();
	const history: Array<{ step: number; action: string; observation: string }> = [];
	let executedToolCount = 0;
	const searchZeroHitCountByQuery = new Map<string, number>();
	let lastActionFingerprint = '';
	let lastResultFingerprint = '';
	let repeatedNonProgressCount = 0;
	let noEditorContextCount = 0;
	let endedByNonProgressLoopBreak = false;

	input.onChunk?.(`### Agent\n- name: ${input.agentName}\n- provider: ${input.settings.provider}\n- model: ${input.settings.model}\n- tools: ${allowedTools.length > 0 ? allowedTools.join(', ') : 'none'}\n\n`);

	if (allowedTools.length === 0) {
		input.onChunk?.('- no tools configured, using direct model response\n\n');
		const directPrompt = [
			input.systemPrompt || '你是一个自主编码代理。',
			'',
			'用户目标：',
			input.question,
			'',
			'工作区上下文：',
			clipString(input.workspaceContext, 2500),
			'',
			'托管上下文：',
			clipString(input.managedContext, 2500),
			'',
			'会话上下文：',
			clipString(input.conversationContext || '暂无历史对话轮次。', 2500)
		].join('\n');
		const direct = await input.queryModel(directPrompt, input.settings, input.signal);
		return (direct || 'Agent 未返回有效结果。').trim();
	}

	for (let step = 1; step <= maxSteps; step += 1) {
		const plannerPrompt = buildPlannerPrompt(input, toolCatalog, history);
		const output = await input.queryModel(plannerPrompt, input.settings, input.signal);
		const parsed = parseStepAction(output || '');
		const plannerPreview = (output || '').trim() || '(empty)';
		input.onChunk?.(`- step ${step}: planner\n`);
		input.onChunk?.(`  - raw: \`${formatJsonInline(plannerPreview, 220)}\`\n`);
		if (parsed) {
			input.onChunk?.(`  - parsed: \`${formatJsonInline(parsed, 220)}\`\n`);
		}

		if (!parsed) {
			const fallback = buildFallbackToolCall(input.question, allowedTools);
			if (!fallback) {
				input.onChunk?.(`- step ${step}: planner output is not valid JSON action, switching to direct answer\n\n`);
				return (output || 'Agent 未返回有效结果。').trim();
			}

			input.onChunk?.(`- step ${step}: planner output invalid, fallback call \`${fallback.tool}\`\n`);
			input.onChunk?.(`  - args: \`${formatJsonInline(fallback.args, 220)}\`\n`);
			const fallbackResult = await dispatcher.execute(fallback.tool, fallback.args, input.signal);
			input.onChunk?.(`  - result: ${summarizeToolResult(fallbackResult)}\n`);
			executedToolCount += 1;
			history.push({
				step,
				action: JSON.stringify({ type: 'tool_call', tool: fallback.tool, args: fallback.args, reason: 'fallback-from-invalid-planner-output' }),
				observation: clipString(JSON.stringify(fallbackResult), 5000)
			});
			emitStepRecord(
				input.onChunk,
				step,
				history[history.length - 1].action,
				history[history.length - 1].observation
			);
			continue;
		}

		if (parsed.type === 'final') {
			if (executedToolCount === 0) {
				const fallback = buildFallbackToolCall(input.question, allowedTools);
				if (fallback) {
					input.onChunk?.(`- step ${step}: planner finalized too early, forcing evidence via \`${fallback.tool}\`\n`);
					input.onChunk?.(`  - args: \`${formatJsonInline(fallback.args, 220)}\`\n`);
					const fallbackResult = await dispatcher.execute(fallback.tool, fallback.args, input.signal);
					input.onChunk?.(`  - result: ${summarizeToolResult(fallbackResult)}\n`);
					executedToolCount += 1;
					history.push({
						step,
						action: JSON.stringify({ type: 'tool_call', tool: fallback.tool, args: fallback.args, reason: 'forced-evidence-before-final' }),
						observation: clipString(JSON.stringify(fallbackResult), 5000)
					});
					emitStepRecord(
						input.onChunk,
						step,
						history[history.length - 1].action,
						history[history.length - 1].observation
					);
					continue;
				}
			}

			input.onChunk?.(`- step ${step}: planner returned final answer\n\n`);
			return parsed.content.trim() || 'Agent 未返回有效结果。';
		}

		const plannedTool = canonicalizePlannedToolName(parsed.tool);
		if (!allowedSet.has(plannedTool)) {
			const fallback = buildFallbackToolCall(input.question, allowedTools);
			if (fallback) {
				input.onChunk?.(`- step ${step}: tool \`${parsed.tool}\` not allowed, fallback call \`${fallback.tool}\`\n`);
				input.onChunk?.(`  - args: \`${formatJsonInline(fallback.args, 220)}\`\n`);
				const fallbackResult = await dispatcher.execute(fallback.tool, fallback.args, input.signal);
				input.onChunk?.(`  - result: ${summarizeToolResult(fallbackResult)}\n`);
				executedToolCount += 1;
				history.push({
					step,
					action: JSON.stringify({ type: 'tool_call', tool: fallback.tool, args: fallback.args, reason: 'fallback-from-disallowed-tool' }),
					observation: clipString(JSON.stringify(fallbackResult), 5000)
				});
				emitStepRecord(
					input.onChunk,
					step,
					history[history.length - 1].action,
					history[history.length - 1].observation
				);
				continue;
			}

			input.onChunk?.(`- step ${step}: tool not allowed \`${parsed.tool}\`, replanning\n`);
			history.push({
				step,
				action: JSON.stringify(parsed),
				observation: `Tool not allowed: ${parsed.tool}`
			});
			emitStepRecord(
				input.onChunk,
				step,
				history[history.length - 1].action,
				history[history.length - 1].observation
			);
			continue;
		}

		const normalizedArgs = normalizePlannedToolArgs(plannedTool, parsed.args || {}, input.question, input.workspaceContext);
		let executionTool = plannedTool;
		let executionArgs = normalizedArgs;
		const preferFileSearch = noEditorContextCount >= 1;

		if (executionTool === 'edit') {
			const editPath = String(executionArgs.path ?? '').trim();
			if (!editPath) {
				const recovery = buildLoopBreakToolCall(input.question, allowedTools, 'edit', { preferFileSearch });
				if (recovery) {
					executionTool = recovery.tool;
					executionArgs = recovery.args;
					input.onChunk?.('  - note: edit missing path, switching to evidence-gathering tool\n');
				}
			}
		}

		if (executionTool === 'execute') {
			const command = String(executionArgs.command ?? '').trim();
			if (!command) {
				executionArgs = { command: inferExecuteCommand(input.question) };
				input.onChunk?.('  - note: execute missing command, using inferred command\n');
			}

			if (input.onExecuteRequested) {
				const decision = await input.onExecuteRequested({
					step,
					command: String(executionArgs.command ?? '').trim()
				});

				if (decision === 'deny') {
					input.onChunk?.('  - note: 用户拒绝执行该命令，跳过 execute 并继续规划\n');
					executedToolCount += 1;
					history.push({
						step,
						action: JSON.stringify({ ...parsed, tool: executionTool, args: executionArgs }),
						observation: '用户拒绝执行命令，execute 未执行。'
					});
					emitStepRecord(
						input.onChunk,
						step,
						history[history.length - 1].action,
						history[history.length - 1].observation
					);
					continue;
				}
			}
		}

		if (executionTool === 'web') {
			const url = String(executionArgs.url ?? '').trim();
			if (!url) {
				const recovery = buildLoopBreakToolCall(input.question, allowedTools, 'web', { preferFileSearch });
				if (recovery) {
					executionTool = recovery.tool;
					executionArgs = recovery.args;
					input.onChunk?.('  - note: web missing url, switching to evidence-gathering tool\n');
				} else {
					input.onChunk?.('  - note: web missing url and no safe alternative tool available, replanning\n');
					history.push({
						step,
						action: JSON.stringify({ ...parsed, tool: executionTool, args: executionArgs }),
						observation: 'web requires a valid url, but none was provided'
					});
					emitStepRecord(
						input.onChunk,
						step,
						history[history.length - 1].action,
						history[history.length - 1].observation
					);
					continue;
				}
			}
		}

		if (plannedTool === 'search') {
			const queryKey = String(normalizedArgs.query ?? '').trim().toLowerCase();
			const zeroCount = searchZeroHitCountByQuery.get(queryKey) ?? 0;
			if (zeroCount >= 1) {
				const loopBreak = buildLoopBreakToolCall(input.question, allowedTools, 'search', { preferFileSearch });
				if (loopBreak) {
					executionTool = loopBreak.tool;
					executionArgs = loopBreak.args;
					input.onChunk?.(`  - note: repeated empty search for same query, switching to \`${loopBreak.tool}\` to gather concrete evidence\n`);
				}
			}
		}

		const actionFingerprint = `${executionTool}:${JSON.stringify(executionArgs)}`;
		if (actionFingerprint === lastActionFingerprint) {
			const loopBreak = buildLoopBreakToolCall(input.question, allowedTools, executionTool, { preferFileSearch });
			if (loopBreak) {
				executionTool = loopBreak.tool;
				executionArgs = loopBreak.args;
				input.onChunk?.(`  - note: detected identical repeated tool call, switching to \`${loopBreak.tool}\` to break loop\n`);
			}
		}

		input.onChunk?.(`- step ${step}: call \`${executionTool}\`${parsed.reason ? ` (${parsed.reason})` : ''}\n`);
		input.onChunk?.(`  - args: \`${formatJsonInline(executionArgs, 220)}\`\n`);
		const result = await dispatcher.execute(executionTool, executionArgs, input.signal);
		input.onChunk?.(`  - result: ${summarizeToolResult(result)}\n`);
		lastActionFingerprint = `${executionTool}:${JSON.stringify(executionArgs)}`;
		if (executionTool === 'execute') {
			const data = result.data as { stdout?: unknown; stderr?: unknown } | undefined;
			const stdout = typeof data?.stdout === 'string' ? clipString(data.stdout.trim(), 1800) : '';
			const stderr = typeof data?.stderr === 'string' ? clipString(data.stderr.trim(), 1200) : '';
			if (stdout) {
				input.onChunk?.('  - stdout:\n\n```text\n' + stdout + '\n```\n');
			}
			if (stderr) {
				input.onChunk?.('  - stderr:\n\n```text\n' + stderr + '\n```\n');
			}
			if (!stdout && !stderr) {
				input.onChunk?.('  - 命令无可显示输出。\n');
			}
		}

		if (executionTool === 'edit' && result.ok && input.onEditApplied) {
			const path = String(executionArgs.path ?? '').trim() || undefined;
			const mode = String(executionArgs.mode ?? '').trim() || undefined;
			const rawContent = String(executionArgs.content ?? '');
			const preview = rawContent.trim().length > 0
				? clipString(rawContent.trim(), 600)
				: undefined;
			const decision = await input.onEditApplied({
				step,
				path,
				mode,
				summary: result.summary,
				preview,
				fileCount: 1,
				files: path ? [{ path, mode }] : []
			});

			if (decision === 'cancel') {
				input.onChunk?.('  - note: 用户取消本次 edit，已停止后续步骤\n\n');
				return '已取消本次文件修改，并已回滚到修改前状态。';
			}

			input.onChunk?.('  - note: 用户确认保留本次 edit，继续后续步骤\n');
		}

		if (executionTool === 'vscode') {
			if (isNoActiveEditorContextResult(result)) {
				noEditorContextCount += 1;
			} else {
				noEditorContextCount = 0;
			}
		}

		const resultFingerprint = `${executionTool}:${result.ok ? 'ok' : 'fail'}:${String(result.summary || '').trim()}:${JSON.stringify(result.data ?? null)}`;
		if (isNonProgressToolResult(executionTool, result) && resultFingerprint === lastResultFingerprint) {
			repeatedNonProgressCount += 1;
		} else if (isNonProgressToolResult(executionTool, result)) {
			repeatedNonProgressCount = 1;
		} else {
			repeatedNonProgressCount = 0;
		}
		lastResultFingerprint = resultFingerprint;

		if (executionTool === 'search') {
			const queryKey = String(executionArgs.query ?? '').trim().toLowerCase();
			if (queryKey) {
				const next = isEmptySearchResult(result)
					? (searchZeroHitCountByQuery.get(queryKey) ?? 0) + 1
					: 0;
				searchZeroHitCountByQuery.set(queryKey, next);
			}
		}

		executedToolCount += 1;
		const observation = clipString(JSON.stringify(result), 5000);
		history.push({
			step,
			action: JSON.stringify({ ...parsed, tool: executionTool, args: executionArgs }),
			observation
		});
		emitStepRecord(
			input.onChunk,
			step,
			history[history.length - 1].action,
			history[history.length - 1].observation
		);

		if (repeatedNonProgressCount >= 2) {
			input.onChunk?.('- detected repeated non-progress observations, stopping tool loop and generating final summary\n\n');
			endedByNonProgressLoopBreak = true;
			break;
		}
	}

	if (executedToolCount === 0) {
		const fallback = buildFallbackToolCall(input.question, allowedTools);
		if (fallback) {
			input.onChunk?.(`- no concrete tool call executed yet, forcing \`${fallback.tool}\` before final summary\n`);
			input.onChunk?.(`  - args: \`${formatJsonInline(fallback.args, 220)}\`\n`);
			const forced = await dispatcher.execute(fallback.tool, fallback.args, input.signal);
			input.onChunk?.(`  - result: ${summarizeToolResult(forced)}\n\n`);
			history.push({
				step: maxSteps + 1,
				action: JSON.stringify({ type: 'tool_call', tool: fallback.tool, args: fallback.args, reason: 'forced-before-final-summary' }),
				observation: clipString(JSON.stringify(forced), 5000)
			});
		}
	}

	const finalPrompt = buildFinalPrompt(input, history, {
		nonProgressLoopBreak: endedByNonProgressLoopBreak
	});
	const final = await input.queryModel(finalPrompt, input.settings, input.signal);
	return (final || 'Agent 未返回有效结果。').trim();
}
