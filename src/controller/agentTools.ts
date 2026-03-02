import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type ToolName = 'read' | 'search' | 'execute' | 'todo' | 'edit' | 'web' | 'vscode';

export type AgentToolDefinition = {
	name: ToolName;
	description: string;
	inputSchema: string;
};

export type AgentToolResult = {
	ok: boolean;
	summary: string;
	data?: unknown;
};

type SearchArgs = {
	query?: unknown;
	scope?: unknown;
	includePattern?: unknown;
	recursive?: unknown;
	isRegexp?: unknown;
	caseSensitive?: unknown;
	maxResults?: unknown;
};

type ReadArgs = {
	action?: unknown;
	path?: unknown;
	startLine?: unknown;
	endLine?: unknown;
	maxChars?: unknown;
};

type EditArgs = {
	path?: unknown;
	mode?: unknown;
	content?: unknown;
};

type EditHookArgs = {
	path: string;
	mode: string;
};

type ExecuteArgs = {
	command?: unknown;
	cwd?: unknown;
	timeoutMs?: unknown;
};

type TodoArgs = {
	action?: unknown;
	id?: unknown;
	title?: unknown;
	description?: unknown;
	acceptance?: unknown;
	dependsOn?: unknown;
	evidence?: unknown;
	goal?: unknown;
	status?: unknown;
};

type WebArgs = {
	url?: unknown;
	query?: unknown;
	maxChars?: unknown;
};

type VSCodeArgs = {
	action?: unknown;
	command?: unknown;
	path?: unknown;
	args?: unknown;
};

type TodoStatus = 'not-started' | 'in-progress' | 'completed';

type TodoItem = {
	id: number;
	title: string;
	description?: string;
	acceptance?: string[];
	dependsOn?: number[];
	evidence?: string;
	status: TodoStatus;
};

let todoItems: TodoItem[] = [];
let nextTodoId = 1;

const TOOL_DEFINITIONS: AgentToolDefinition[] = [
	{
		name: 'search',
		description: '在工作区搜索文本或文件名，并返回匹配结果。',
		inputSchema: '{ "query": string, "scope"?: "text"|"files", "includePattern"?: string, "recursive"?: boolean, "isRegexp"?: boolean, "caseSensitive"?: boolean, "maxResults"?: number }'
	},
	{
		name: 'read',
		description: '读取工作区文件或当前编辑器内容，可选行范围。',
		inputSchema: '{ "action"?: "file"|"activeEditor", "path"?: string, "startLine"?: number, "endLine"?: number, "maxChars"?: number }'
	},
	{
		name: 'execute',
		description: '在工作区根目录执行 shell 命令并返回 stdout/stderr。',
		inputSchema: '{ "command": string, "cwd"?: string, "timeoutMs"?: number }'
	},
	{
		name: 'todo',
		description: '管理结构化计划项，支持依赖关系与验收标准。',
		inputSchema: '{ "action": "list"|"add"|"update"|"remove"|"clear"|"plan"|"next", "goal"?: string, "id"?: number, "title"?: string, "description"?: string, "acceptance"?: string[], "dependsOn"?: number[], "evidence"?: string, "status"?: "not-started"|"in-progress"|"completed" }'
	},
	{
		name: 'edit',
		description: '操作(编辑，删除，创建)工作区内的文件。',
		inputSchema: '{ "path": string, "mode": "create"|"replace"|"append"|"delete", "content"?: string }'
	},
	{
		name: 'web',
		description: '从网页 URL 抓取并提取文本内容。',
		inputSchema: '{ "url": string, "query"?: string, "maxChars"?: number }'
	},
	{
		name: 'vscode',
		description: '调用 VS Code 能力，例如读取编辑器上下文或执行命令。',
		inputSchema: '{ "action": "context"|"problems"|"openFile"|"runCommand", "path"?: string, "command"?: string, "args"?: unknown[] }'
	}
];

function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const num = Number(value);
	if (!Number.isFinite(num)) {
		return fallback;
	}

	return Math.max(min, Math.min(max, Math.floor(num)));
}

function resolveWorkspaceFilePath(inputPath: string): { absolutePath: string; relativePath: string } {
	const root = getWorkspaceRoot();
	if (!root) {
		throw new Error('No workspace folder is open.');
	}

	const normalizedInput = inputPath.trim();
	if (!normalizedInput) {
		throw new Error('Path is required.');
	}

	const normalizedForResolve = normalizeWorkspacePrefixedRelativePath(root, normalizedInput);
	const absolutePath = path.isAbsolute(normalizedForResolve)
		? path.resolve(normalizedForResolve)
		: path.resolve(root, normalizedForResolve);
	const relativePath = path.relative(root, absolutePath);
	if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
		throw new Error('Path must be inside current workspace.');
	}

	return { absolutePath, relativePath: relativePath.split(path.sep).join('/') };
}

function normalizeWorkspacePrefixedRelativePath(root: string, inputPath: string): string {
	if (path.isAbsolute(inputPath)) {
		return inputPath;
	}

	const normalizedInput = inputPath.replace(/\\/g, '/').replace(/^\.\//, '');
	const workspaceName = path.basename(root).replace(/\\/g, '/');
	const workspacePrefix = `${workspaceName}/`;
	if (!normalizedInput.startsWith(workspacePrefix)) {
		return inputPath;
	}

	const stripped = normalizedInput.slice(workspacePrefix.length);
	if (!stripped) {
		return inputPath;
	}

	const originalAbs = path.resolve(root, normalizedInput);
	const strippedAbs = path.resolve(root, stripped);
	if (!fs.existsSync(originalAbs) && fs.existsSync(strippedAbs)) {
		return stripped;
	}

	return inputPath;
}

function toUriFromWorkspacePath(inputPath: string): vscode.Uri {
	const { absolutePath } = resolveWorkspaceFilePath(inputPath);
	return vscode.Uri.file(absolutePath);
}

async function executeSearch(args: SearchArgs): Promise<AgentToolResult> {
	const query = String(args.query ?? '').trim();
	if (!query) {
		return { ok: false, summary: 'query is required for search' };
	}

	const scope = String(args.scope ?? 'text').trim();
	const includePattern = String(args.includePattern ?? '').trim();
	const recursive = args.recursive === undefined ? true : Boolean(args.recursive);

	const maxResults = clampNumber(args.maxResults, 20, 1, 100);
	const hits: Array<{ path: string; line: number; preview: string }> = [];
	if (scope === 'files') {
		const effectivePattern = includePattern
			? (recursive ? ensureRecursiveGlob(includePattern) : includePattern)
			: (recursive ? `**/*${query}*` : `*${query}*`);
		const files = await vscode.workspace.findFiles(effectivePattern, '**/{node_modules,.git,dist,build,out,.next,.turbo}/**', maxResults);
		return {
			ok: true,
			summary: `Found ${files.length} file match(es). scope=files recursive=${recursive ? 'true' : 'false'} includePattern=${effectivePattern}`,
			data: files.map((item) => ({
				path: vscode.workspace.asRelativePath(item, false)
			}))
		};
	}

	const isRegexp = Boolean(args.isRegexp);
	const caseSensitive = Boolean(args.caseSensitive);
	const matcher = isRegexp
		? new RegExp(query, caseSensitive ? 'g' : 'gi')
		: undefined;
	const needle = caseSensitive ? query : query.toLowerCase();

	const effectivePattern = includePattern
		? (recursive ? ensureRecursiveGlob(includePattern) : includePattern)
		: (recursive ? '**/*' : '*');

	const files = await vscode.workspace.findFiles(
		effectivePattern,
		'**/{node_modules,.git,dist,build,out,.next,.turbo}/**',
		300
	);

	for (const file of files) {
		if (hits.length >= maxResults) {
			break;
		}

		let text = '';
		try {
			text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
		} catch {
			continue;
		}

		if (text.includes('\u0000')) {
			continue;
		}

		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			if (hits.length >= maxResults) {
				break;
			}

			const lineText = lines[index];
			const matched = matcher
				? matcher.test(lineText)
				: (caseSensitive ? lineText : lineText.toLowerCase()).includes(needle);
			if (!matched) {
				if (matcher) {
					matcher.lastIndex = 0;
				}
				continue;
			}

			hits.push({
				path: vscode.workspace.asRelativePath(file, false),
				line: index + 1,
				preview: lineText.trim()
			});

			if (matcher) {
				matcher.lastIndex = 0;
			}
		}
	}

	return {
		ok: true,
		summary: `Found ${hits.length} match(es). scope=text recursive=${recursive ? 'true' : 'false'} includePattern=${effectivePattern}`,
		data: hits
	};
}

function ensureRecursiveGlob(includePattern: string): string {
	const normalized = includePattern.trim();
	if (!normalized) {
		return '**/*';
	}

	if (normalized.startsWith('**/')) {
		return normalized;
	}

	if (normalized.includes('/**') || normalized.includes('**')) {
		return normalized;
	}

	return `**/${normalized}`;
}

async function executeRead(args: ReadArgs): Promise<AgentToolResult> {
	const action = String(args.action ?? 'file').trim();
	const inputPath = String(args.path ?? '').trim();
	if (action === 'activeEditor') {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const root = getWorkspaceRoot();
			if (!root) {
				return { ok: false, summary: 'No active editor and no workspace folder is open.' };
			}

			const rootUri = vscode.Uri.file(root);
			let entries: [string, vscode.FileType][] = [];
			try {
				entries = await vscode.workspace.fs.readDirectory(rootUri);
			} catch {
				entries = [];
			}

			const preferredNames = ['README.md', 'readme.md', 'package.json', 'Makefile'];
			const fileEntries = entries
				.filter((item) => item[1] === vscode.FileType.File)
				.map((item) => item[0]);
			const preferred = preferredNames.find((name) => fileEntries.includes(name));
			const fallbackFile = preferred || fileEntries[0];

			if (fallbackFile) {
				const uri = vscode.Uri.file(path.join(root, fallbackFile));
				try {
					const raw = await vscode.workspace.fs.readFile(uri);
					const text = new TextDecoder().decode(raw);
					const lines = text.split(/\r?\n/);
					const startLine = clampNumber(args.startLine, 1, 1, Math.max(lines.length, 1));
					const endLine = clampNumber(args.endLine, Math.min(lines.length, startLine + 199), startLine, Math.max(lines.length, startLine));
					const maxChars = clampNumber(args.maxChars, 12000, 200, 30000);
					const selected = lines.slice(startLine - 1, endLine).join('\n');
					const clipped = selected.length > maxChars ? `${selected.slice(0, maxChars)}\n...[truncated]` : selected;
					return {
						ok: true,
						summary: `No active editor. Fallback read ${fallbackFile} lines ${startLine}-${endLine}.`,
						data: {
							cwd: root,
							path: fallbackFile,
							startLine,
							endLine,
							content: clipped
						}
					};
				} catch {
					// fall through to directory listing fallback
				}
			}

			return {
				ok: true,
				summary: 'No active editor. Using workspace root fallback context.',
				data: {
					cwd: root,
					entries: entries.slice(0, 50).map((item) => ({
						name: item[0],
						type: item[1] === vscode.FileType.Directory ? 'dir' : 'file'
					}))
				}
			};
		}

		const text = editor.document.getText();
		const lines = text.split(/\r?\n/);
		const startLine = clampNumber(args.startLine, 1, 1, Math.max(lines.length, 1));
		const endLine = clampNumber(args.endLine, Math.min(lines.length, startLine + 199), startLine, Math.max(lines.length, startLine));
		const maxChars = clampNumber(args.maxChars, 12000, 200, 30000);
		const selected = lines.slice(startLine - 1, endLine).join('\n');
		const clipped = selected.length > maxChars ? `${selected.slice(0, maxChars)}\n...[truncated]` : selected;
		return {
			ok: true,
			summary: `Read active editor lines ${startLine}-${endLine}.`,
			data: {
				path: vscode.workspace.asRelativePath(editor.document.uri, false),
				startLine,
				endLine,
				content: clipped
			}
		};
	}

	if (!inputPath) {
		return { ok: false, summary: 'path is required for read action file' };
	}

	const uri = toUriFromWorkspacePath(inputPath);
	const raw = await vscode.workspace.fs.readFile(uri);
	const text = new TextDecoder().decode(raw);
	const lines = text.split(/\r?\n/);
	const startLine = clampNumber(args.startLine, 1, 1, Math.max(lines.length, 1));
	const endLine = clampNumber(args.endLine, Math.min(lines.length, startLine + 199), startLine, Math.max(lines.length, startLine));
	const maxChars = clampNumber(args.maxChars, 12000, 200, 30000);
	const selected = lines.slice(startLine - 1, endLine).join('\n');
	const clipped = selected.length > maxChars ? `${selected.slice(0, maxChars)}\n...[truncated]` : selected;

	return {
		ok: true,
		summary: `Read ${inputPath} lines ${startLine}-${endLine}.`,
		data: {
			path: inputPath,
			startLine,
			endLine,
			content: clipped
		}
	};
}

async function executeEdit(args: EditArgs, onBeforeEdit?: (args: EditHookArgs) => Promise<void>): Promise<AgentToolResult> {
	const inputPath = String(args.path ?? '').trim();
	const mode = String(args.mode ?? 'replace').trim();
	const content = String(args.content ?? '');
	if (!inputPath) {
		return { ok: false, summary: 'path is required for edit' };
	}

	if (!['create', 'replace', 'append', 'delete'].includes(mode)) {
		return { ok: false, summary: 'mode must be one of: create, replace, append, delete' };
	}

	if (onBeforeEdit) {
		await onBeforeEdit({ path: inputPath, mode });
	}

	const uri = toUriFromWorkspacePath(inputPath);
	const encoder = new TextEncoder();

	if (mode === 'create') {
		try {
			await vscode.workspace.fs.stat(uri);
			return { ok: false, summary: `File already exists: ${inputPath}` };
		} catch {
			const parent = vscode.Uri.file(path.dirname(uri.fsPath));
			await vscode.workspace.fs.createDirectory(parent);
			await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
			return { ok: true, summary: `Created file: ${inputPath}` };
		}
	}

	if (mode === 'append') {
		let existing = '';
		try {
			existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			existing = '';
		}
		const merged = existing.length > 0 ? `${existing}${content}` : content;
		await vscode.workspace.fs.writeFile(uri, encoder.encode(merged));
		return { ok: true, summary: `Appended content to: ${inputPath}` };
	}

	if (mode === 'delete') {
		try {
			await vscode.workspace.fs.delete(uri);
			return { ok: true, summary: `Deleted file: ${inputPath}` };
		} catch (error) {
			return { ok: false, summary: `Failed to delete file: ${inputPath} (${error instanceof Error ? error.message : 'unknown error'})` };
		}
	}

	await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
	return { ok: true, summary: `Replaced file content: ${inputPath}` };
}

function normalizeDiagnostics(entries: readonly vscode.Diagnostic[]): Array<{ line: number; severity: string; message: string; source?: string }> {
	return entries.slice(0, 50).map((item) => ({
		line: item.range.start.line + 1,
		severity: item.severity === vscode.DiagnosticSeverity.Error
			? 'error'
			: item.severity === vscode.DiagnosticSeverity.Warning
				? 'warning'
				: item.severity === vscode.DiagnosticSeverity.Information
					? 'info'
					: 'hint',
		message: item.message,
		source: item.source
	}));
}

async function executeExecute(args: ExecuteArgs, signal?: AbortSignal): Promise<AgentToolResult> {
	const command = String(args.command ?? '').trim();
	if (!command) {
		return { ok: false, summary: 'command is required for execute' };
	}

	const root = getWorkspaceRoot();
	if (!root) {
		return { ok: false, summary: 'No workspace folder is open.' };
	}

	const rawCwd = String(args.cwd ?? '').trim();
	const cwd = rawCwd ? resolveWorkspaceFilePath(rawCwd).absolutePath : root;

	const timeout = clampNumber(args.timeoutMs, 30000, 1000, 120000);
	const clipOutput = (value: string, maxChars: number): string => {
		return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
	};

	const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		exec(command, {
			cwd,
			timeout,
			maxBuffer: 256 * 1024,
			signal
		}, (error, stdout, stderr) => {
			if (error) {
				const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
				reject({
					err,
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? '')
				});
				return;
			}

			resolve({ stdout, stderr });
		});
	}).catch((payload: {
		err: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
		stdout: string;
		stderr: string;
	}) => payload);

	if ('err' in output) {
		const err = output.err;
		const stdout = clipOutput(output.stdout, 12000);
		const stderr = clipOutput(output.stderr, 4000);
		const combined = `${stderr}\n${stdout}\n${err.message || ''}`.toLowerCase();
		const timeoutLike = err.code === 'ETIMEDOUT'
			|| combined.includes('timed out')
			|| (Boolean(err.killed) && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL'));
		const abortedLike = err.name === 'AbortError' || combined.includes('aborted');
		const numericExitCode = typeof err.code === 'number'
			? err.code
			: (typeof err.code === 'string' && /^\d+$/.test(err.code) ? Number(err.code) : undefined);

		if (timeoutLike) {
			return {
				ok: false,
				summary: `命令执行超时（>${timeout}ms）。`,
				data: {
					type: 'timeout',
					command,
					cwd,
					timeoutMs: timeout,
					stdout,
					stderr,
					suggestions: ['先运行更小范围命令（例如单文件/单用例）。', '如果确认命令耗时较长，请提高 timeoutMs 后重试。']
				}
			};
		}

		if (abortedLike) {
			return {
				ok: false,
				summary: '命令已取消。',
				data: {
					type: 'aborted',
					command,
					cwd,
					timeoutMs: timeout,
					stdout,
					stderr,
					suggestions: ['如需继续，请重新发起执行。', '可先缩小命令范围再重试。']
				}
			};
		}

		if (numericExitCode !== undefined) {
			return {
				ok: false,
				summary: `命令执行失败（退出码 ${numericExitCode}）。`,
				data: {
					type: 'nonzero-exit',
					command,
					cwd,
					exitCode: numericExitCode,
					stdout,
					stderr,
					suggestions: ['先查看 stderr 首屏错误并修复根因。', '可改用更聚焦的命令做最小复现。']
				}
			};
		}

		return {
			ok: false,
			summary: `命令无法启动：${String(err.code ?? 'unknown')}`,
			data: {
				type: 'spawn-error',
				command,
				cwd,
				errno: String(err.code ?? 'unknown'),
				stdout,
				stderr,
				suggestions: ['检查命令是否存在于 PATH。', '确认 cwd 与运行权限是否正确。']
			}
		};
	}

	const clippedStdout = clipOutput(output.stdout, 12000);
	const clippedStderr = clipOutput(output.stderr, 4000);
	return {
		ok: true,
		summary: '命令执行成功。',
		data: {
			stdout: clippedStdout,
			stderr: clippedStderr
		}
	};
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
	const status = String(value ?? '').trim();
	if (status === 'not-started' || status === 'in-progress' || status === 'completed') {
		return status;
	}

	return undefined;
}

function normalizeStringArray(value: unknown, limit = 8): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.slice(0, limit);
}

function normalizeNumberArray(value: unknown, limit = 8): number[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const result: number[] = [];
	for (const item of value) {
		const num = Number(item);
		if (Number.isFinite(num)) {
			result.push(Math.floor(num));
		}
		if (result.length >= limit) {
			break;
		}
	}

	return result;
}

function buildPlannedTodos(goal: string): TodoItem[] {
	const base = goal.replace(/\s+/g, ' ').trim();
	const step1: TodoItem = {
		id: nextTodoId++,
		title: 'Clarify requirements and scope',
		description: `Break down goal and constraints: ${base}`,
		acceptance: ['明确输入输出', '列出关键约束与边界情况'],
		dependsOn: [],
		status: 'not-started'
	};
	const step2: TodoItem = {
		id: nextTodoId++,
		title: 'Locate affected files',
		description: 'Find and read candidate files before editing',
		acceptance: ['已定位主要实现文件', '已读取关键上下文'],
		dependsOn: [step1.id],
		status: 'not-started'
	};
	const step3: TodoItem = {
		id: nextTodoId++,
		title: 'Implement minimal changes',
		description: 'Apply focused edits that satisfy the goal',
		acceptance: ['改动与目标一致', '避免无关修改'],
		dependsOn: [step2.id],
		status: 'not-started'
	};
	const step4: TodoItem = {
		id: nextTodoId++,
		title: 'Validate and summarize',
		description: 'Run checks and prepare final explanation',
		acceptance: ['关键验证命令通过或给出失败原因', '总结变更与后续建议'],
		dependsOn: [step3.id],
		status: 'not-started'
	};

	return [step1, step2, step3, step4];
}

function findNextActionableTodo(items: TodoItem[]): TodoItem | undefined {
	const completedIds = new Set(items.filter((item) => item.status === 'completed').map((item) => item.id));
	return items.find((item) => {
		if (item.status !== 'not-started') {
			return false;
		}

		const deps = item.dependsOn || [];
		return deps.every((dep) => completedIds.has(dep));
	});
}

async function executeTodo(args: TodoArgs): Promise<AgentToolResult> {
	const action = String(args.action ?? 'list').trim();
	if (!action || action === 'list') {
		const completed = todoItems.filter((item) => item.status === 'completed').length;
		const inProgress = todoItems.filter((item) => item.status === 'in-progress').length;
		const next = findNextActionableTodo(todoItems);
		return {
			ok: true,
			summary: `Todo items: ${todoItems.length} (completed: ${completed}, in-progress: ${inProgress})`,
			data: {
				items: [...todoItems],
				next
			}
		};
	}

	if (action === 'plan') {
		const goal = String(args.goal ?? args.title ?? '').trim();
		if (!goal) {
			return { ok: false, summary: 'goal is required for todo plan' };
		}

		todoItems = buildPlannedTodos(goal);
		return {
			ok: true,
			summary: `Generated plan with ${todoItems.length} todo items`,
			data: {
				goal,
				items: [...todoItems],
				next: findNextActionableTodo(todoItems)
			}
		};
	}

	if (action === 'next') {
		const next = findNextActionableTodo(todoItems);
		if (!next) {
			return { ok: true, summary: 'No actionable todo item', data: { next: undefined, items: [...todoItems] } };
		}

		return { ok: true, summary: `Next actionable todo: #${next.id}`, data: { next, items: [...todoItems] } };
	}

	if (action === 'add') {
		const title = String(args.title ?? '').trim();
		if (!title) {
			return { ok: false, summary: 'title is required for todo add' };
		}

		const status = normalizeTodoStatus(args.status) ?? 'not-started';
		const description = String(args.description ?? '').trim();
		const acceptance = normalizeStringArray(args.acceptance);
		const dependsOn = normalizeNumberArray(args.dependsOn);
		const item: TodoItem = {
			id: nextTodoId++,
			title,
			description: description || undefined,
			acceptance: acceptance.length > 0 ? acceptance : undefined,
			dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
			status
		};
		todoItems = [...todoItems, item];
		return { ok: true, summary: `Added todo #${item.id}`, data: item };
	}

	if (action === 'update') {
		const id = Number(args.id);
		if (!Number.isFinite(id)) {
			return { ok: false, summary: 'id is required for todo update' };
		}

		const title = String(args.title ?? '').trim();
		const description = String(args.description ?? '').trim();
		const status = normalizeTodoStatus(args.status);
		const acceptance = normalizeStringArray(args.acceptance);
		const dependsOn = normalizeNumberArray(args.dependsOn);
		const evidence = String(args.evidence ?? '').trim();
		let updated: TodoItem | undefined;
		todoItems = todoItems.map((item) => {
			if (item.id !== id) {
				return item;
			}

			updated = {
				...item,
				title: title || item.title,
				description: description || item.description,
				acceptance: acceptance.length > 0 ? acceptance : item.acceptance,
				dependsOn: dependsOn.length > 0 ? dependsOn : item.dependsOn,
				evidence: evidence || item.evidence,
				status: status ?? item.status
			};
			return updated;
		});

		if (!updated) {
			return { ok: false, summary: `Todo #${id} not found` };
		}

		return { ok: true, summary: `Updated todo #${id}`, data: updated };
	}

	if (action === 'remove') {
		const id = Number(args.id);
		if (!Number.isFinite(id)) {
			return { ok: false, summary: 'id is required for todo remove' };
		}

		const before = todoItems.length;
		todoItems = todoItems.filter((item) => item.id !== id);
		return {
			ok: before !== todoItems.length,
			summary: before !== todoItems.length ? `Removed todo #${id}` : `Todo #${id} not found`,
			data: [...todoItems]
		};
	}

	if (action === 'clear') {
		todoItems = [];
		return { ok: true, summary: 'Cleared all todo items', data: [] };
	}

	return { ok: false, summary: `Unsupported todo action: ${action}` };
}

function stripHtmlToText(value: string): string {
	return value
		.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractTitleFromHtml(value: string): string {
	const matched = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (!matched?.[1]) {
		return '';
	}

	return stripHtmlToText(matched[1]);
}

function buildWebQuerySnippets(text: string, query: string): string[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return [];
	}

	const parts = text.split(/[。！？.!?\n]+/).map((item) => item.trim()).filter((item) => item.length > 0);
	return parts
		.filter((item) => item.toLowerCase().includes(normalized))
		.slice(0, 10);
}

async function executeWeb(args: WebArgs): Promise<AgentToolResult> {
	const urlValue = String(args.url ?? '').trim();
	if (!urlValue) {
		return { ok: false, summary: 'url is required for web' };
	}
	const query = String(args.query ?? '').trim();

	let parsed: URL;
	try {
		parsed = new URL(urlValue);
	} catch {
		return { ok: false, summary: `Invalid URL: ${urlValue}` };
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, summary: 'Only http/https URLs are supported' };
	}

	const response = await fetch(parsed.toString(), { method: 'GET' });
	if (!response.ok) {
		return { ok: false, summary: `Web request failed: ${response.status} ${response.statusText}` };
	}

	const raw = await response.text();
	const title = extractTitleFromHtml(raw);
	const text = stripHtmlToText(raw);
	const maxChars = clampNumber(args.maxChars, 12000, 200, 50000);
	const content = text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
	const snippets = query ? buildWebQuerySnippets(text, query) : [];
	return {
		ok: true,
		summary: `Fetched ${parsed.toString()}`,
		data: {
			url: parsed.toString(),
			title,
			content,
			query: query || undefined,
			snippets
		}
	};
}

async function executeVSCode(args: VSCodeArgs): Promise<AgentToolResult> {
	const action = String(args.action ?? 'context').trim();
	if (!action || action === 'context') {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return { ok: true, summary: 'No active editor context', data: {} };
		}

		const selected = editor.document.getText(editor.selection).trim();
		return {
			ok: true,
			summary: 'Collected active editor context',
			data: {
				file: vscode.workspace.asRelativePath(editor.document.uri, false),
				language: editor.document.languageId,
				selection: selected
			}
		};
	}

	if (action === 'runCommand') {
		const command = String(args.command ?? '').trim();
		if (!command) {
			return { ok: false, summary: 'command is required for vscode action runCommand' };
		}

		const commandArgs = Array.isArray(args.args) ? args.args : [];
		const result = await vscode.commands.executeCommand(command, ...commandArgs);
		return {
			ok: true,
			summary: `Executed VS Code command: ${command}`,
			data: {
				result
			}
		};
	}

	if (action === 'problems') {
		const all = vscode.languages.getDiagnostics();
		const flattened = all
			.filter(([, diagnostics]) => diagnostics.length > 0)
			.slice(0, 30)
			.map(([uri, diagnostics]) => ({
				path: vscode.workspace.asRelativePath(uri, false),
				diagnostics: normalizeDiagnostics(diagnostics)
			}));

		const total = flattened.reduce((sum, item) => sum + item.diagnostics.length, 0);
		return {
			ok: true,
			summary: `Collected ${total} problem(s) across ${flattened.length} file(s).`,
			data: flattened
		};
	}

	if (action === 'openFile') {
		const filePath = String(args.path ?? '').trim();
		if (!filePath) {
			return { ok: false, summary: 'path is required for vscode action openFile' };
		}

		const uri = toUriFromWorkspacePath(filePath);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });
		return {
			ok: true,
			summary: `Opened file in editor: ${filePath}`,
			data: { path: filePath }
		};
	}

	return { ok: false, summary: `Unsupported vscode action: ${action}` };
}

export function getAgentToolDefinitions(): AgentToolDefinition[] {
	return TOOL_DEFINITIONS;
}

export function normalizeAgentToolName(value: string): ToolName | undefined {
	const raw = String(value || '').trim();
	if (!raw) {
		return undefined;
	}

	const exact = TOOL_DEFINITIONS.find((item) => item.name === raw);
	if (exact) {
		return exact.name;
	}

	return undefined;
}

export function normalizeAgentToolNames(values: string[]): ToolName[] {
	const result: ToolName[] = [];
	const seen = new Set<string>();
	for (const item of values) {
		const normalized = normalizeAgentToolName(item);
		if (!normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

export class AgentToolDispatcher {
	constructor(private readonly options?: {
		onBeforeEdit?: (args: EditHookArgs) => Promise<void>;
	}) {}

	public async execute(toolName: string, rawArgs: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
		try {
			const normalized = normalizeAgentToolName(toolName);
			if (!normalized) {
				return { ok: false, summary: `Unsupported tool: ${toolName}` };
			}

			if (normalized === 'search') {
				return executeSearch((rawArgs ?? {}) as SearchArgs);
			}

			if (normalized === 'read') {
				return executeRead((rawArgs ?? {}) as ReadArgs);
			}

			if (normalized === 'edit') {
				return executeEdit((rawArgs ?? {}) as EditArgs, this.options?.onBeforeEdit);
			}

			if (normalized === 'execute') {
				return executeExecute((rawArgs ?? {}) as ExecuteArgs, signal);
			}

			if (normalized === 'todo') {
				return executeTodo((rawArgs ?? {}) as TodoArgs);
			}

			if (normalized === 'web') {
				return executeWeb((rawArgs ?? {}) as WebArgs);
			}

			if (normalized === 'vscode') {
				return executeVSCode((rawArgs ?? {}) as VSCodeArgs);
			}

			return { ok: false, summary: `Unsupported tool: ${toolName}` };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown tool execution error';
			return { ok: false, summary: message };
		}
	}
}
