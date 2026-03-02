import * as vscode from 'vscode';
import {
	CHECK_PROVIDER_COMMAND,
	CONFIGURE_MODEL_COMMAND,
	OPEN_MODEL_MANAGER_COMMAND
} from './constants';
import { type ConnectionCheckResult } from '../model/types';

type ChatController = {
	revealView(): void;
	askAndReveal(question: string): Promise<void>;
	getLastSuggestion(): string;
	notifyConfigChanged(): void;
};

type StatusController = vscode.Disposable & {
	setChecking(): void;
	setResult(result: ConnectionCheckResult): void;
	refreshForConfigChange(): void;
	startAutoRefresh(checkAction: () => Promise<void>): void;
};

type RegisterExtensionControllersDeps = {
	context: vscode.ExtensionContext;
	extensionUri: vscode.Uri;
	chatViewType: string;
	chatProvider: ChatController & vscode.WebviewViewProvider;
	statusBar: StatusController;
	outputChannel: vscode.OutputChannel;
	checkProviderConnection: () => Promise<ConnectionCheckResult>;
	runModelConfigurationWizard: (
		runProviderConnectionCheck: (showNotification: boolean) => Promise<ConnectionCheckResult>
	) => Promise<void>;
	openModelManager: (
		extensionUri: vscode.Uri,
		runProviderConnectionCheck: (showNotification: boolean) => Promise<ConnectionCheckResult>
	) => void;
	insertTextToEditor: (text: string) => Promise<void>;
};

export function registerExtensionControllers(deps: RegisterExtensionControllersDeps): void {
	const runProviderConnectionCheck = async (showNotification: boolean): Promise<ConnectionCheckResult> => {
		deps.statusBar.setChecking();
		const result = await deps.checkProviderConnection();
		deps.statusBar.setResult(result);

		if (showNotification) {
			if (result.ok) {
				vscode.window.showInformationMessage(`EnoHacker provider check passed: ${result.message}`);
			} else {
				vscode.window.showErrorMessage(`EnoHacker provider check failed: ${result.message}`);
			}
		}

		return result;
	};

	deps.context.subscriptions.push(
		deps.outputChannel,
		deps.statusBar,
		vscode.window.registerWebviewViewProvider(deps.chatViewType, deps.chatProvider),
		vscode.commands.registerCommand('enohacker.openChat', () => deps.chatProvider.revealView()),
		vscode.commands.registerCommand('enohacker.askFromSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor found.');
				return;
			}

			const selectedText = editor.document.getText(editor.selection).trim();
			const question = await vscode.window.showInputBox({
				prompt: 'Ask EnoHacker about selected code',
				placeHolder: 'e.g. explain this, optimize this, write tests for this'
			});

			if (!question?.trim()) {
				return;
			}

			const payload = selectedText
				? `${question.trim()}\n\nSelected code:\n${selectedText}`
				: question.trim();
			await deps.chatProvider.askAndReveal(payload);
		}),
		vscode.commands.registerCommand('enohacker.insertLastSuggestion', async () => {
			await deps.insertTextToEditor(deps.chatProvider.getLastSuggestion());
		}),
		vscode.commands.registerCommand(CHECK_PROVIDER_COMMAND, async () => {
			await runProviderConnectionCheck(true);
		}),
		vscode.commands.registerCommand(CONFIGURE_MODEL_COMMAND, async () => {
			await deps.runModelConfigurationWizard(runProviderConnectionCheck);
		}),
		vscode.commands.registerCommand(OPEN_MODEL_MANAGER_COMMAND, async () => {
			deps.openModelManager(deps.extensionUri, runProviderConnectionCheck);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration('enohacker')) {
				return;
			}

			deps.statusBar.refreshForConfigChange();
			deps.chatProvider.notifyConfigChanged();
			void runProviderConnectionCheck(false);
		})
	);

	deps.statusBar.startAutoRefresh(async () => {
		await runProviderConnectionCheck(false);
	});

	void runProviderConnectionCheck(false);
}
