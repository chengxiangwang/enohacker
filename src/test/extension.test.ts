import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { AgentToolDispatcher } from '../controller/agentTools';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('read activeEditor falls back to workspace context when no editor', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const dispatcher = new AgentToolDispatcher();
		const result = await dispatcher.execute('read', { action: 'activeEditor', startLine: 1, endLine: 50 });

		assert.notStrictEqual(result.summary, 'No active editor for read action activeEditor');
		if (!result.ok) {
			assert.ok(result.summary.includes('no workspace folder is open'));
		}
	});

	test('todo plan creates structured items and next returns actionable item', async () => {
		const dispatcher = new AgentToolDispatcher();
		await dispatcher.execute('todo', { action: 'clear' });

		const planned = await dispatcher.execute('todo', { action: 'plan', goal: '开发一个可以远程执行命令的脚本' });
		assert.strictEqual(planned.ok, true);
		assert.ok(planned.summary.includes('Generated plan'));

		const next = await dispatcher.execute('todo', { action: 'next' });
		assert.strictEqual(next.ok, true);
		assert.ok(next.summary.includes('Next actionable todo'));
	});

	test('execute timeout returns friendly structured result', async () => {
		const dispatcher = new AgentToolDispatcher();
		const result = await dispatcher.execute('execute', {
			command: 'node -e "setTimeout(() => console.log(123), 2000)"',
			timeoutMs: 1000
		});

		assert.strictEqual(result.ok, false);
		if (result.summary.includes('No workspace folder is open')) {
			assert.ok(result.summary.includes('No workspace folder is open'));
			return;
		}

		const data = result.data as { type?: unknown; suggestions?: unknown[] };
		assert.strictEqual(data.type, 'timeout');
		assert.ok(Array.isArray(data.suggestions));
	});

	test('execute nonzero exit returns friendly structured result', async () => {
		const dispatcher = new AgentToolDispatcher();
		const result = await dispatcher.execute('execute', {
			command: 'node -e "process.stderr.write(\"boom\\n\"); process.exit(2)"'
		});

		assert.strictEqual(result.ok, false);
		if (result.summary.includes('No workspace folder is open')) {
			assert.ok(result.summary.includes('No workspace folder is open'));
			return;
		}

		const data = result.data as { type?: unknown; exitCode?: unknown; stderr?: unknown };
		assert.strictEqual(data.type, 'nonzero-exit');
		assert.strictEqual(data.exitCode, 2);
		assert.ok(String(data.stderr || '').includes('boom'));
	});

	test('search with recursive=false only matches top-level files', async () => {
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspacePath) {
			assert.ok(true, 'no workspace folder is open');
			return;
		}

		const nestedDir = path.join(workspacePath, 'tmp-search-recursive', 'nested');
		const nestedFile = path.join(nestedDir, 'probe.txt');
		const topFile = path.join(workspacePath, 'tmp-search-recursive-probe.txt');
		await fs.promises.mkdir(nestedDir, { recursive: true });
		await fs.promises.writeFile(nestedFile, 'nested probe', 'utf8');
		await fs.promises.writeFile(topFile, 'top probe', 'utf8');

		try {
			const dispatcher = new AgentToolDispatcher();
			const recursiveFalse = await dispatcher.execute('search', {
				query: 'probe',
				scope: 'files',
				recursive: false,
				includePattern: '*probe*',
				maxResults: 20
			});
			const recursiveTrue = await dispatcher.execute('search', {
				query: 'probe',
				scope: 'files',
				recursive: true,
				includePattern: '*probe*',
				maxResults: 20
			});

			const topRelative = 'tmp-search-recursive-probe.txt';
			const nestedRelative = 'tmp-search-recursive/nested/probe.txt';

			const falseData = Array.isArray(recursiveFalse.data) ? recursiveFalse.data as Array<{ path?: string }> : [];
			const trueData = Array.isArray(recursiveTrue.data) ? recursiveTrue.data as Array<{ path?: string }> : [];
			assert.ok(recursiveFalse.summary.includes('recursive=false'));
			assert.ok(recursiveFalse.summary.includes('includePattern=*probe*'));
			assert.ok(recursiveTrue.summary.includes('recursive=true'));
			assert.ok(recursiveTrue.summary.includes('includePattern=**/*probe*'));

			assert.ok(falseData.some((item) => item.path === topRelative));
			assert.ok(!falseData.some((item) => item.path === nestedRelative));
			assert.ok(trueData.some((item) => item.path === nestedRelative));
		} finally {
			await fs.promises.rm(path.join(workspacePath, 'tmp-search-recursive'), { recursive: true, force: true });
			await fs.promises.rm(topFile, { force: true });
		}
	});

	test('read handles workspace-prefixed relative path without duplicating root segment', async () => {
		const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspacePath) {
			assert.ok(true, 'no workspace folder is open');
			return;
		}

		const workspaceName = path.basename(workspacePath);
		const fileName = 'tmp-prefixed-read.txt';
		const absoluteFile = path.join(workspacePath, fileName);
		await fs.promises.writeFile(absoluteFile, 'prefixed-read-ok\nline2', 'utf8');

		try {
			const dispatcher = new AgentToolDispatcher();
			const result = await dispatcher.execute('read', {
				action: 'file',
				path: `${workspaceName}/${fileName}`,
				startLine: 1,
				endLine: 2
			});

			assert.strictEqual(result.ok, true);
			const data = result.data as { path?: unknown; content?: unknown };
			assert.strictEqual(data.path, fileName);
			assert.ok(String(data.content || '').includes('prefixed-read-ok'));
		} finally {
			await fs.promises.rm(absoluteFile, { force: true });
		}
	});
});
