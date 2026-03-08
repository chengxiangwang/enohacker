import * as vscode from 'vscode';
import { PiRunner } from '../agent/piRunner';

export class EnoHackerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enohacker.sidebarView';
  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly runner: PiRunner, private readonly output?: vscode.OutputChannel) {}

  public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const messageHandler = async (msg: any) => {
      try {
        if (msg.type === 'startRpc') {
          this.output?.appendLine('[INFO] sidebar requested startHiddenRpc');
          try {
            await this.runner.startHiddenRpc();
            webviewView.webview.postMessage({ type: 'rpcStarted' });
          } catch (e) {
            this.output?.appendLine('[ERROR] startHiddenRpc failed: ' + String(e));
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }
        } else if (msg.type === 'startTerminal') {
          this.output?.appendLine('[INFO] sidebar requested startTerminal');
          try {
            await this.runner.startTerminal('pi (enohacker)', { integrated: true });
            webviewView.webview.postMessage({ type: 'terminalStarted' });
          } catch (e) {
            this.output?.appendLine('[ERROR] startTerminal failed: ' + String(e));
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }
        } else if (msg.type === 'sendCommand') {
          this.output?.appendLine('[INFO] sidebar sendCommand: ' + JSON.stringify(msg.command));
          try {
            this.runner.sendCommand(msg.command);
          } catch (e) {
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }
        }
      } catch (e) {
        this.output?.appendLine('[ERROR] message handler failed: ' + String(e));
      }
    };

    webviewView.webview.onDidReceiveMessage(messageHandler, undefined, this.disposables);

    const evDisp = this.runner.onEvent((ev: any) => {
      try {
        webviewView.webview.postMessage({ type: 'event', event: ev });
      } catch (e) {
        // ignore
      }
    });
    this.disposables.push(evDisp);

    webviewView.onDidDispose(() => {
      while (this.disposables.length) {
        const d = this.disposables.pop();
        try { d?.dispose(); } catch {}
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}';">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>EnoHacker Agent</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); padding: 8px; }
  button { margin-right: 8px; }
  #events { white-space: pre-wrap; margin-top: 8px; max-height: 300px; overflow:auto; border: 1px solid var(--vscode-editorWidget-border); padding: 6px; border-radius:4px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  input[type="text"] { width:70%; }
</style>
</head>
<body>
  <h3>EnoHacker UI Agent</h3>
  <div>
    <button id="start-rpc">Start RPC</button>
    <button id="start-terminal">Open Terminal</button>
    <button id="stop-all">Stop</button>
  </div>
  <div style="margin-top:8px;">
    <input id="cmd-input" type="text" placeholder='{"type":"noop"}' />
    <button id="send-cmd">Send Command</button>
  </div>
  <div id="events"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const events = document.getElementById('events');
  document.getElementById('start-rpc').addEventListener('click', () => { vscode.postMessage({ type: 'startRpc' }); });
  document.getElementById('start-terminal').addEventListener('click', () => { vscode.postMessage({ type: 'startTerminal' }); });
  document.getElementById('stop-all').addEventListener('click', () => { vscode.postMessage({ type: 'sendCommand', command: { type: 'stop' } }); });
  document.getElementById('send-cmd').addEventListener('click', () => {
    const v = (document.getElementById('cmd-input')).value;
    try {
      const obj = JSON.parse(v);
      vscode.postMessage({ type: 'sendCommand', command: obj });
    } catch (e) {
      appendLine('[ERROR] invalid JSON: ' + e);
    }
  });

  function appendLine(s) {
    events.textContent += s + "\n";
    events.scrollTop = events.scrollHeight;
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'event') {
      appendLine('[EVENT] ' + JSON.stringify(msg.event));
    } else if (msg.type === 'rpcStarted') {
      appendLine('[INFO] rpc started');
    } else if (msg.type === 'terminalStarted') {
      appendLine('[INFO] terminal started');
    } else if (msg.type === 'error') {
      appendLine('[ERROR] ' + msg.error);
    } else {
      appendLine('[MSG] ' + JSON.stringify(msg));
    }
  });
</script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export default EnoHackerSidebarProvider;
