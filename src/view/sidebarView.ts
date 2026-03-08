import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PiRunner } from '../agent/piRunner';

export class EnoHackerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'enohacker.sidebarView';
  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  // Track pending/active prompt request ids so we can correlate subsequent streaming events (RPC events don't include id)
  private pendingPromptId?: string;
  private activePromptIds: string[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly runner: PiRunner, private readonly output?: vscode.OutputChannel) {}

  public resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    this.output?.appendLine('[DEBUG] resolveWebviewView called');
    this.output?.appendLine('[DEBUG] current rpc pid: ' + String(this.runner.getRpcPid()));

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const messageHandler = async (msg: any) => {
      try {
        this.output?.appendLine('[DEBUG] sidebar message received: ' + JSON.stringify(msg));

        if (msg.type === 'startTerminal') {
          this.output?.appendLine('[INFO] sidebar requested startTerminal');
          try {
            await this.runner.startTerminal('pi (enohacker)', { integrated: true });
            webviewView.webview.postMessage({ type: 'terminalStarted' });
          } catch (e) {
            this.output?.appendLine('[ERROR] startTerminal failed: ' + String(e));
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }

        } else if (msg.type === 'startRpc') {
          this.output?.appendLine('[INFO] sidebar requested startHiddenRpc');
          try {
            await this.runner.startHiddenRpc({ waitForReady: true, timeoutMs: 5000, readyPredicate: (ev: any) => ev && (ev.type === 'rpc_ready' || ev.type === 'rpc_started') });
            webviewView.webview.postMessage({ type: 'rpcStarted', pid: this.runner.getRpcPid() });
          } catch (e) {
            this.output?.appendLine('[ERROR] startHiddenRpc failed: ' + String(e));
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }

        } else if (msg.type === 'sendCommand') {
          this.output?.appendLine('[INFO] sidebar sendCommand: ' + JSON.stringify(msg.command));
          try {
            await this.runner.sendCommand(msg.command);
          } catch (e) {
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }

        } else if (msg.type === 'request_completion') {
          // Frontend requests a completion; ensure RPC is running then forward the request
          this.output?.appendLine('[INFO] sidebar requested completion: ' + JSON.stringify({ id: msg.id }));
          try {
            await this.runner.startHiddenRpc({ waitForReady: true, timeoutMs: 5000, readyPredicate: (ev: any) => ev && (ev.type === 'rpc_ready' || ev.type === 'rpc_started') });
            // Forward to RPC using the official RPC command 'prompt'
            // Store pendingPromptId so subsequent streaming events can be correlated to this request
            this.pendingPromptId = msg.id;
            await this.runner.sendCommand({ type: 'prompt', id: msg.id, message: msg.prompt });
            this.output?.appendLine('[DEBUG] forwarded prompt to RPC: id=' + String(msg.id));
          } catch (e) {
            this.output?.appendLine('[ERROR] completion request failed: ' + String(e));
            webviewView.webview.postMessage({ type: 'error', error: String(e) });
          }

        } else {
          this.output?.appendLine('[WARN] unknown message type received from sidebar: ' + JSON.stringify(msg));
          
        }
      } catch (e) {
        this.output?.appendLine('[ERROR] message handler failed: ' + String(e));
      }
    };

    webviewView.webview.onDidReceiveMessage(messageHandler, undefined, this.disposables);

    const evDisp = this.runner.onEvent((ev: any) => {
      try {
        this.output?.appendLine('[DEBUG] prompt response from RPC: ' + JSON.stringify(ev));
      } catch (e) {
        // ignore
      }
    });
    this.disposables.push(evDisp);

    // Also forward raw stdout chunks (useful for debugging when RPC emits non-JSON streaming)
    const rawDisp = this.runner.onRaw((s: string) => {
      try {
        webviewView.webview.postMessage({ type: 'event', event: { type: 'raw_output', text: String(s) } });
      } catch (e) {}
    });
    this.disposables.push(rawDisp);

    // Attempt to start the headless RPC when the sidebar is resolved (view shown)
    (async () => {
      try {
        this.output?.appendLine('[INFO] sidebar resolving: attempting to start hidden RPC');
        await this.runner.startHiddenRpc();
        await this.runner.sendCommand({"type": "get_state"});
        try { webviewView.webview.postMessage({"type": "get_state"}); } catch (e) { /* ignore */ }
      } catch (e) {
        this.output?.appendLine('[WARN] failed to start hidden RPC on resolve: ' + String(e));
        try { webviewView.webview.postMessage({ type: 'error', error: String(e) }); } catch (e) { /* ignore */ }
      }
    })();

    // Refresh webview HTML each time the view becomes visible to ensure latest UI is shown (handles retainContextWhenHidden)
    try {
      webviewView.onDidChangeVisibility(() => {
        try {
          if (webviewView.visible) {
            this.output?.appendLine('[DEBUG] sidebar visible — refreshing webview HTML');
            webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
            try { webviewView.webview.postMessage({"type": "get_state"}); } catch (e) { /* ignore */ }
          }
        } catch (e) {
          this.output?.appendLine('[DEBUG] onDidChangeVisibility handler failed: ' + String(e));
        }
      });
    } catch (e) {
      // ignore if API not available
    }

    webviewView.onDidDispose(() => {
      while (this.disposables.length) {
        const d = this.disposables.pop();
        try { d?.dispose(); } catch {}
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();
    const htmlPath = path.join(this.context.extensionUri.fsPath, 'media', 'sidebar.html');

    let html: string | undefined;

    try {
      html = fs.readFileSync(htmlPath, 'utf8');
      this.output?.appendLine('[DEBUG] loaded media/sidebar.html (' + String(html.length) + ' bytes) from ' + htmlPath);
    } catch (e) {
      this.output?.appendLine('[ERROR] failed to read media/sidebar.html: ' + String(e));
      html = undefined;
    }

    // Build webview URIs for media
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.js'));

    // Ensure html is a string then replace placeholders
    html = (html || '')
      .replace(/%WEBVIEW_CSP_SOURCE%/g, webview.cspSource)
      .replace(/%STYLE_URI%/g, String(styleUri))
      .replace(/%SCRIPT_URI%/g, String(scriptUri));

    return html;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export default EnoHackerSidebarProvider;
