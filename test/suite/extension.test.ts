import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('enohacker-ai activates', async () => {
    const extension = vscode.extensions.getExtension('your-name.enohacker-ai');
    await extension?.activate();
    assert.ok(extension?.isActive);
  });
});
