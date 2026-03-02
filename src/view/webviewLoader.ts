import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as NodeJS.ErrnoException & { cause?: unknown }).cause;
		const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : '';
		return `${error.message}${causeMsg}`;
	}

	return 'unknown error';
}

export function loadWebviewHtml(extensionUri: vscode.Uri, fileName: string): string {
	const fileUri = vscode.Uri.joinPath(extensionUri, 'media', fileName);

	try {
		return readFileSync(fileUri.fsPath, 'utf8');
	} catch (error) {
		return `<!DOCTYPE html><html><body><h3>Failed to load view: ${fileName}</h3><pre>${toErrorMessage(error)}</pre></body></html>`;
	}
}
