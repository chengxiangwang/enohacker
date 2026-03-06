/* eslint-disable no-useless-escape */
import * as vscode from 'vscode';
import { CodingAgentManager, AgentOutput } from './codingAgentManager';

export function activate(context: vscode.ExtensionContext) {
  console.log('enohacker-ai: activated');

  const agentManager = new CodingAgentManager(context);
  context.subscriptions.push(agentManager);

  // Simple example command (keeps previous behavior)
  const disposable = vscode.commands.registerCommand('enohacker-ai.start', async () => {
    const editor = vscode.window.activeTextEditor;
    let message = 'Hello from Enohacker AI!';
    if (editor) {
      const selection = editor.document.getText(editor.selection);
      if (selection && selection.trim().length > 0) {
        message = `Selected text:\n${selection}`;
      }
    }
    vscode.window.showInformationMessage(message);
  });
  context.subscriptions.push(disposable);

  // Install coding-agent (if vendor not present)
  context.subscriptions.push(
    vscode.commands.registerCommand('enohacker-ai.installCodingAgent', async () => {
      const choice = await vscode.window.showInformationMessage(
        'Install coding-agent into the extension vendor folder? This will download from npm and may take a while.',
        'Install',
        'Cancel'
      );
      if (choice !== 'Install') return;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Installing coding-agent',
            cancellable: false,
          },
          async (progress) => {
            await agentManager.install(progress as any);
          }
        );
        vscode.window.showInformationMessage('coding-agent installed into extension vendor.');
      } catch (err: any) {
        vscode.window.showErrorMessage('Failed to install coding-agent: ' + String(err));
      }
    })
  );

  // Start/Stop commands (can be invoked from command palette or webview)
  context.subscriptions.push(
    vscode.commands.registerCommand('enohacker-ai.startAgent', async (...cmdArgs: any[]) => {
      const runMode = vscode.workspace
        .getConfiguration('enohacker-ai')
        .get<string>('codingAgent.runMode', 'spawn');
      const useTerminal = runMode === 'terminal';
      let args: string[] = [];
      if (cmdArgs && cmdArgs.length > 0 && Array.isArray(cmdArgs[0])) {
        args = cmdArgs[0];
      }
      agentManager.start(args, useTerminal);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('enohacker-ai.stopAgent', () => {
      agentManager.stop();
    })
  );

  // Register the webview view provider (activity bar)
  const provider = new EnohackerViewProvider(context, agentManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EnohackerViewProvider.viewType, provider)
  );
}

export function deactivate(): void {
  // nothing here; manager is disposed via subscriptions if needed
}

class EnohackerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enohackerAI.mainView';
  private _view?: vscode.WebviewView;
  private _outputListener?: vscode.Disposable;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _manager: CodingAgentManager
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'start': {
          const args: string[] = Array.isArray(message.args) ? message.args : [];
          const runMode = vscode.workspace
            .getConfiguration('enohacker-ai')
            .get<string>('codingAgent.runMode', 'spawn');
          const useTerminal = runMode === 'terminal';
          this._manager.start(args, useTerminal);
          break;
        }
        case 'stop':
          this._manager.stop();
          break;
        case 'install':
          vscode.commands.executeCommand('enohacker-ai.installCodingAgent');
          break;
      }
    });

    // forward manager output to webview
    this._outputListener = this._manager.onOutput((o: AgentOutput) => {
      try {
        webviewView.webview.postMessage(o as any);
      } catch (err) {
        // ignore if webview is not ready
      }
    }) as unknown as vscode.Disposable;

    webviewView.onDidDispose(() => {
      try {
        this._outputListener?.dispose();
      } catch (e) {
        console.error(e);
      }
      this._outputListener = undefined;
      this._view = undefined;
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    const startId = 'startBtn';
    const stopId = 'stopBtn';
    const installId = 'installBtn';
    const argsId = 'argsInput';
    const clearId = 'clearBtn';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Enohacker AI</title>
  <style>
    body { font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); background: transparent }
    .controls { display:flex; gap:8px; margin-bottom:8px }
    #log { height: 300px; overflow:auto; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); padding:8px; white-space: pre-wrap; border-radius:4px }
    input[type="text"] { flex:1 }
    button { height:28px }
  </style>
</head>
<body>
  <div class="controls">
    <button id="${startId}">Start</button>
    <button id="${stopId}">Stop</button>
    <button id="${installId}">Install</button>
    <button id="${clearId}">Clear</button>
  </div>
  <div style="margin-bottom:8px; display:flex; gap:8px;">
    <input id="${argsId}" type="text" placeholder="Additional CLI args (space separated)" />
  </div>
  <div id="log" role="log" aria-live="polite"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const startBtn = document.getElementById('${startId}');
    const stopBtn = document.getElementById('${stopId}');
    const installBtn = document.getElementById('${installId}');
    const clearBtn = document.getElementById('${clearId}');
    const argsInput = document.getElementById('${argsId}');
    const log = document.getElementById('log');

    function appendLine(text, cls) {
      const el = document.createElement('div');
      if (cls) el.className = cls;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    startBtn.addEventListener('click', () => {
      const raw = argsInput.value || '';
      const args = raw.trim().length ? raw.split(/\s+/) : [];
      vscode.postMessage({ command: 'start', args });
    });
    stopBtn.addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
    installBtn.addEventListener('click', () => vscode.postMessage({ command: 'install' }));
    clearBtn.addEventListener('click', () => log.innerText = '');

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'stdout') appendLine(msg.text || '');
      else if (msg.type === 'stderr') appendLine('[ERR] ' + (msg.text || ''));
      else if (msg.type === 'exit') appendLine('Process exited: ' + String(msg.code));
    });
  </script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
