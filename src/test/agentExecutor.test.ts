import * as assert from 'assert';
import { runAgentWithTools } from '../controller/agentExecutor';
import { type ModelSettings } from '../model/types';

type ToolCall = {
	toolName: string;
	rawArgs: unknown;
};

class MockDispatcher {
	public readonly calls: ToolCall[] = [];

	public async execute(toolName: string, rawArgs: unknown): Promise<{ ok: boolean; summary: string; data?: unknown }> {
		this.calls.push({ toolName, rawArgs });
		return {
			ok: true,
			summary: `mock executed: ${toolName}`,
			data: { toolName, rawArgs }
		};
	}
}

class LoopingSearchMockDispatcher {
	public readonly calls: ToolCall[] = [];

	public async execute(toolName: string, rawArgs: unknown): Promise<{ ok: boolean; summary: string; data?: unknown }> {
		this.calls.push({ toolName, rawArgs });
		if (toolName === 'search') {
			return {
				ok: true,
				summary: 'Found 0 match(es).',
				data: []
			};
		}

		return {
			ok: true,
			summary: `mock executed: ${toolName}`,
			data: { toolName, rawArgs }
		};
	}
}

class NoEditorContextMockDispatcher {
	public readonly calls: ToolCall[] = [];

	public async execute(toolName: string, rawArgs: unknown): Promise<{ ok: boolean; summary: string; data?: unknown }> {
		this.calls.push({ toolName, rawArgs });
		if (toolName === 'vscode') {
			return {
				ok: true,
				summary: 'No active editor context',
				data: {}
			};
		}

		return {
			ok: true,
			summary: `mock executed: ${toolName}`,
			data: { toolName, rawArgs }
		};
	}
}

function createSettings(): ModelSettings {
	return {
		provider: 'openai',
		model: 'gpt-4o-mini',
		baseUrl: '',
		apiKey: 'test-key',
		temperature: 0.2
	};
}

suite('Agent Executor Regression', () => {
	test('fallback executes real tool when planner output is invalid JSON', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: 'find usage of runAgentWithTools',
			agentName: 'test-agent',
			allowedTools: ['search', 'read'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return 'not-a-json-action';
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'search');
		assert.strictEqual(result, 'final summary');
	});

	test('disallowed planned tool triggers fallback tool execution', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'read current file',
			agentName: 'test-agent',
			allowedTools: ['read'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'unsupported_tool',
						args: { query: 'x' }
					});
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'read');
	});

	test('early final forces at least one concrete tool execution', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'collect evidence then answer',
			agentName: 'test-agent',
			allowedTools: ['search'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'final', content: 'done too early' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'search');
	});

	test('tool alias run_in_terminal is canonicalized to execute', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: 'run a command',
			agentName: 'test-agent',
			allowedTools: ['execute'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'run_in_terminal',
						args: { command: 'echo test' }
					});
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'execute');
		assert.strictEqual(result, 'done');
	});

	test('planned search call without query gets auto-filled', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'find controller usage in workspace',
			agentName: 'test-agent',
			allowedTools: ['search'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'search', args: {} });
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'search');
		const firstArgs = dispatcher.calls[0].rawArgs as { query?: unknown; scope?: unknown; recursive?: unknown; maxResults?: unknown };
		assert.strictEqual(typeof firstArgs.query, 'string');
		assert.ok(String(firstArgs.query).trim().length > 0);
		assert.strictEqual(firstArgs.scope, 'text');
		assert.strictEqual(firstArgs.recursive, true);
		assert.strictEqual(firstArgs.maxResults, 10);
	});

	test('planned edit call without path infers path from workspace context', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'update current file',
			agentName: 'test-agent',
			allowedTools: ['edit', 'read'],
			workspaceContext: 'file: /Users/test/workspace/src/extension.ts\n\nlanguage: typescript',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'edit', args: { mode: 'replace', content: 'x' } });
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'edit');
		const firstArgs = dispatcher.calls[0].rawArgs as { path?: unknown };
		assert.strictEqual(firstArgs.path, '/Users/test/workspace/src/extension.ts');
	});

	test('planner output is emitted in step stream', async () => {
		const dispatcher = new MockDispatcher();
		const chunks: string[] = [];

		await runAgentWithTools({
			question: 'find controller usage in workspace',
			agentName: 'test-agent',
			allowedTools: ['search'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			onChunk: (chunk) => {
				chunks.push(chunk);
			},
			queryModel: async () => JSON.stringify({ type: 'tool_call', tool: 'search', args: { query: 'controller' } })
		});

		const merged = chunks.join('');
		assert.ok(merged.includes('step 1: planner'));
		assert.ok(merged.includes('"type":"tool_call"'));
	});

	test('repeated empty search calls are loop-broken by switching to read', async () => {
		const dispatcher = new LoopingSearchMockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: '开发一个copilot vscode插件',
			agentName: 'test-agent',
			allowedTools: ['search', 'read'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 4,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount <= 3) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'search',
						args: { query: '开发一个copilot vscode插件', scope: 'text', maxResults: 10 }
					});
				}
				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 3);
		assert.strictEqual(dispatcher.calls[0].toolName, 'search');
		assert.ok(dispatcher.calls.slice(1).some((call) => call.toolName === 'read'));
	});

	test('execute without command runs with inferred command', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'collect context first',
			agentName: 'test-agent',
			allowedTools: ['execute', 'vscode'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'execute', args: {} });
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'execute');
		const firstArgs = dispatcher.calls[0].rawArgs as { command?: unknown };
		assert.strictEqual(firstArgs.command, 'pwd');
	});

	test('execute-only plan without command uses safe default command', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: 'run something',
			agentName: 'test-agent',
			allowedTools: ['execute'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'execute', args: {} });
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'execute');
		const firstArgs = dispatcher.calls[0].rawArgs as { command?: unknown };
		assert.strictEqual(firstArgs.command, 'npm run dev');
	});

	test('web without url is recovered by switching to search', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: '开发一个类似postman的vscode插件',
			agentName: 'test-agent',
			allowedTools: ['web', 'search', 'vscode'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'web', args: {} });
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'search');
	});

	test('web-only plan without url does not execute invalid web call', async () => {
		const dispatcher = new MockDispatcher();

		await runAgentWithTools({
			question: 'summarize docs without url',
			agentName: 'test-agent',
			allowedTools: ['web'],
			workspaceContext: 'ctx',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async () => JSON.stringify({ type: 'tool_call', tool: 'web', args: {} })
		});

		assert.strictEqual(dispatcher.calls.length, 0);
	});

	test('repeated web-to-vscode non-progress loop exits early', async () => {
		const dispatcher = new NoEditorContextMockDispatcher();

		await runAgentWithTools({
			question: 'make a vscode plugin like postman',
			agentName: 'test-agent',
			allowedTools: ['web', 'vscode'],
			workspaceContext: 'No active editor context.',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 4,
			dispatcher: dispatcher as never,
			queryModel: async () => JSON.stringify({ type: 'tool_call', tool: 'web', args: {} })
		});

		assert.ok(dispatcher.calls.length <= 2);
		assert.ok(dispatcher.calls.every((call) => call.toolName !== 'web'));
	});

	test('final prompt includes non-progress guardrails after repeated non-progress loop break', async () => {
		const dispatcher = new NoEditorContextMockDispatcher();
		let capturedFinalPrompt = '';

		await runAgentWithTools({
			question: 'make a vscode plugin like postman',
			agentName: 'test-agent',
			allowedTools: ['web', 'vscode'],
			workspaceContext: 'No active editor context.',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 4,
			dispatcher: dispatcher as never,
			queryModel: async (prompt) => {
				if (prompt.includes('请基于工具观察与用户目标，生成给用户的最终回复。')) {
					capturedFinalPrompt = prompt;
					return 'final summary';
				}

				return JSON.stringify({ type: 'tool_call', tool: 'web', args: {} });
			}
		});

		assert.ok(capturedFinalPrompt.includes('检测到此前存在连续 non-progress 观察'));
		assert.ok(capturedFinalPrompt.includes('禁止输出“请确认是否继续执行”'));
		assert.ok(capturedFinalPrompt.includes('优先 execute 验证'));
	});

	test('repeated no-editor vscode context escalates loop-break search to files scope', async () => {
		const dispatcher = new NoEditorContextMockDispatcher();

		await runAgentWithTools({
			question: '开发一个类似postman的vscode插件',
			agentName: 'test-agent',
			allowedTools: ['vscode', 'search'],
			workspaceContext: 'No active editor context.',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 3,
			dispatcher: dispatcher as never,
			queryModel: async () => JSON.stringify({
				type: 'tool_call',
				tool: 'vscode',
				args: { action: 'context' }
			})
		});

		const searchCall = dispatcher.calls.find((call) => call.toolName === 'search');
		assert.ok(searchCall);
		const args = searchCall?.rawArgs as { scope?: unknown };
		assert.strictEqual(args.scope, 'files');
	});

	test('implementation prompts allow creating new files once path is decided', async () => {
		const dispatcher = new MockDispatcher();
		let capturedPrompt = '';

		await runAgentWithTools({
			question: '开发一个可远程执行命令的bash脚本',
			agentName: 'test-agent',
			allowedTools: ['todo', 'search', 'edit'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async (prompt) => {
				if (!capturedPrompt) {
					capturedPrompt = prompt;
				}
				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.ok(capturedPrompt.includes('创建新文件可在路径与内容目标明确后执行'));
		assert.ok(capturedPrompt.includes('前期验证优先单命令 execute'));
		assert.ok(capturedPrompt.includes('仅在临近最终验收时，才可合并多个验证命令'));
		assert.ok(capturedPrompt.includes('禁止把“当前进展总结/下一步计划”当作完成结果'));
		assert.ok(capturedPrompt.includes('禁止向用户询问“是否继续执行/是否继续创建文件”等流程性确认'));
		assert.ok(capturedPrompt.includes('禁止输出“请确认是否继续执行”这类用户交互话术'));
		assert.ok(capturedPrompt.includes('默认 recursive=true 递归搜索子目录'));
		assert.ok(capturedPrompt.includes('若上一步观察为 non-progress，优先返回能产生增量证据的 tool_call；仅在已满足完成条件或存在明确阻塞时才返回 final'));
	});

	test('implementation prompts require execute validation before final when execute is available', async () => {
		const dispatcher = new MockDispatcher();
		let capturedPrompt = '';

		await runAgentWithTools({
			question: '开发一个可远程执行命令的bash脚本',
			agentName: 'test-agent',
			allowedTools: ['todo', 'search', 'edit', 'execute'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 1,
			dispatcher: dispatcher as never,
			queryModel: async (prompt) => {
				if (!capturedPrompt) {
					capturedPrompt = prompt;
				}
				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.ok(capturedPrompt.includes('长任务在 final 前必须至少触发一次 execute tool_call'));
		assert.ok(capturedPrompt.includes('若出现“进展总结/下一步计划”但缺少验证证据，不要 final，优先进入 execute'));
		assert.ok(capturedPrompt.includes('若连续出现非进展观察（空结果/上下文无变化），禁止直接总结收尾'));
	});

	test('implementation flow can execute edit for new file path without forced read/search pre-step', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		await runAgentWithTools({
			question: '开发一个可远程执行命令的bash脚本',
			agentName: 'test-agent',
			allowedTools: ['todo', 'edit', 'search'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'edit',
						args: {
							path: '/Users/test/workspace/scripts/remote-exec.sh',
							mode: 'create',
							content: '#!/usr/bin/env bash\necho "ok"\n'
						}
					});
				}
				if (requestCount === 2) {
					return JSON.stringify({ type: 'final', content: 'done' });
				}
				return 'final summary';
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'edit');
		const firstArgs = dispatcher.calls[0].rawArgs as { path?: unknown; mode?: unknown };
		assert.strictEqual(firstArgs.path, '/Users/test/workspace/scripts/remote-exec.sh');
		assert.strictEqual(firstArgs.mode, 'create');
	});

	test('implementation workflow advances from todo plan/next to edit before final', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: '开发一个可远程执行命令的bash脚本',
			agentName: 'test-agent',
			allowedTools: ['todo', 'edit', 'search'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 4,
			dispatcher: dispatcher as never,
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'todo',
						args: { action: 'plan', goal: '开发一个可远程执行命令的bash脚本' }
					});
				}
				if (requestCount === 2) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'todo',
						args: { action: 'next' }
					});
				}
				if (requestCount === 3) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'edit',
						args: {
							path: '/Users/test/workspace/scripts/remote-exec.sh',
							mode: 'create',
							content: '#!/usr/bin/env bash\necho "ok"\n'
						}
					});
				}
				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(result, 'done');
		assert.strictEqual(dispatcher.calls.length, 3);
		assert.strictEqual(dispatcher.calls[0].toolName, 'todo');
		assert.strictEqual(dispatcher.calls[1].toolName, 'todo');
		assert.strictEqual(dispatcher.calls[2].toolName, 'edit');
		const editArgs = dispatcher.calls[2].rawArgs as { path?: unknown; mode?: unknown };
		assert.strictEqual(editArgs.path, '/Users/test/workspace/scripts/remote-exec.sh');
		assert.strictEqual(editArgs.mode, 'create');
	});

	test('omitted maxSteps is not capped at 300', async () => {
		const dispatcher = new MockDispatcher();
		let plannerTurns = 0;

		const result = await runAgentWithTools({
			question: '开发一个可远程执行命令的bash脚本',
			agentName: 'test-agent',
			allowedTools: ['todo'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			dispatcher: dispatcher as never,
			queryModel: async (prompt) => {
				if (prompt.includes('工具观察：')) {
					return 'final summary (should not be used in this test)';
				}

				plannerTurns += 1;
				if (plannerTurns <= 320) {
					return JSON.stringify({ type: 'tool_call', tool: 'todo', args: { action: 'list' } });
				}

				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 320);
		assert.strictEqual(result, 'done');
	});

	test('edit confirmation cancel stops loop after edit', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: '创建一个脚本文件',
			agentName: 'test-agent',
			allowedTools: ['edit'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 3,
			dispatcher: dispatcher as never,
			onEditApplied: async () => 'cancel',
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'edit',
						args: {
							path: '/Users/test/workspace/scripts/a.sh',
							mode: 'create',
							content: 'echo ok\n'
						}
					});
				}

				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'edit');
		assert.strictEqual(requestCount, 1);
		assert.strictEqual(result, '已取消本次文件修改，并已回滚到修改前状态。');
	});

	test('edit confirmation keep allows next steps', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: '创建一个脚本文件',
			agentName: 'test-agent',
			allowedTools: ['edit'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			onEditApplied: async () => 'keep',
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({
						type: 'tool_call',
						tool: 'edit',
						args: {
							path: '/Users/test/workspace/scripts/a.sh',
							mode: 'create',
							content: 'echo ok\n'
						}
					});
				}

				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(requestCount, 2);
		assert.strictEqual(result, 'done');
	});

	test('execute confirmation deny skips command execution and replans', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: '运行测试',
			agentName: 'test-agent',
			allowedTools: ['execute'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			onExecuteRequested: async () => 'deny',
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'execute', args: { command: 'npm test' } });
				}

				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 0);
		assert.strictEqual(requestCount, 2);
		assert.strictEqual(result, 'done');
	});

	test('execute confirmation allow runs command normally', async () => {
		const dispatcher = new MockDispatcher();
		let requestCount = 0;

		const result = await runAgentWithTools({
			question: '运行测试',
			agentName: 'test-agent',
			allowedTools: ['execute'],
			workspaceContext: 'workspace: /Users/test/workspace',
			managedContext: 'managed',
			settings: createSettings(),
			maxSteps: 2,
			dispatcher: dispatcher as never,
			onExecuteRequested: async () => 'allow',
			queryModel: async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return JSON.stringify({ type: 'tool_call', tool: 'execute', args: { command: 'npm test' } });
				}

				return JSON.stringify({ type: 'final', content: 'done' });
			}
		});

		assert.strictEqual(dispatcher.calls.length, 1);
		assert.strictEqual(dispatcher.calls[0].toolName, 'execute');
		assert.strictEqual(requestCount, 2);
		assert.strictEqual(result, 'done');
	});
});
