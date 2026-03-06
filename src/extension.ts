import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

// 开发阶段布局优先：默认启用 layout-only 模式，不启动 pi 子进程（便于在 Extension Dev Host 中快速预览界面）
const LAYOUT_ONLY = true;

let outputChannel: vscode.OutputChannel | undefined;

// Helper: build webview HTML for both sidebar webview view and standalone panel
function buildSidebarHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const filePath = path.join(context.extensionPath, 'media', 'sidebar.html');
  let html = '';
  try { html = fs.readFileSync(filePath, 'utf8'); } catch (e) { html = `<body><h3>Sidebar template not found</h3><pre>${String(e)}</pre></body>`; }

  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'sidebar.js')));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'sidebar.css')));

  html = html.replace(/\{\{SCRIPT_URI\}\}/g, String(scriptUri));
  html = html.replace(/\{\{STYLE_URI\}\}/g, String(styleUri));

  return html;
}

export function activate(context: vscode.ExtensionContext) {
  // create output channel for debugging
  outputChannel = vscode.window.createOutputChannel('EnoHacker');
  context.subscriptions.push(outputChannel);
  outputChannel?.appendLine('[INFO] activating enohacker extension');

  try {
    const provider = new EnoHackerViewProvider(context);
    outputChannel?.appendLine('[INFO] registering WebviewViewProvider for enohacker.sidebarView');
    const disposable = vscode.window.registerWebviewViewProvider('enohacker.sidebarView', provider, { webviewOptions: { retainContextWhenHidden: true } });
    context.subscriptions.push(disposable);
    outputChannel?.appendLine('[INFO] provider registered');

    context.subscriptions.push(vscode.commands.registerCommand('enohacker.showSidebar', async () => {
      try {
        outputChannel?.appendLine('[INFO] showSidebar command invoked');
        // correct command to reveal a contributed activitybar view container is
        // 'workbench.view.extension.<viewContainerId>'
        await vscode.commands.executeCommand('workbench.view.extension.enohacker-sidebar');
      } catch (err) {
        outputChannel?.appendLine('[WARN] reveal command failed: ' + String(err));
      }
    }));

    // Provide a fallback command to open the UI as a panel (useful when the webview view isn't materializing)
    context.subscriptions.push(vscode.commands.registerCommand('enohacker.openPanel', async () => {
      outputChannel?.appendLine('[INFO] enohacker.openPanel invoked');
      try {
        const panel = vscode.window.createWebviewPanel(
          'enohackerPanel',
          'EnoHacker',
          { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
          { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))] }
        );
        panel.webview.html = buildSidebarHtml(context, panel.webview);
        outputChannel?.appendLine('[INFO] opened enohacker panel');
      } catch (e) {
        outputChannel?.appendLine('[ERROR] openPanel failed: ' + String(e));
      }
    }));


    // debug notification
    try { vscode.window.showInformationMessage('EnoHacker activated'); } catch {}
    outputChannel?.appendLine('[INFO] activation complete');

    // Debug: print extension's packageJSON as seen by VS Code
    try {
      const extId = '2207LHI.enohacker';
      const ext = vscode.extensions.getExtension(extId);
      if (ext) {
        const contributes = (ext.packageJSON && ext.packageJSON.contributes) ? ext.packageJSON.contributes : undefined;
        outputChannel?.appendLine('[DEBUG] extension package contributes: ' + JSON.stringify(contributes, null, 2));
      } else {
        outputChannel?.appendLine('[DEBUG] extension not found via vscode.extensions.getExtension("' + extId + '")');
      }
    } catch (e) {
      outputChannel?.appendLine('[DEBUG] failed to inspect extension packageJSON: ' + String(e));
    }

    // Force reveal the sidebar view once on activation to ensure resolveWebviewView is called
    try {
      // Give the workbench a moment to settle, then reveal the container and focus the side bar.
      setTimeout(async () => {
        try {
          outputChannel?.appendLine('[DEBUG] enumerating commands to help debug view reveal');
          const cmds = await vscode.commands.getCommands(true);
          const matches = cmds.filter(c => c.includes('view') || c.includes('enohacker'));
          outputChannel?.appendLine('[DEBUG] commands matching view/enohacker: ' + JSON.stringify(matches.slice(0, 20)));

          await vscode.commands.executeCommand('enohacker.showSidebar');
          outputChannel?.appendLine('[INFO] invoked enohacker.showSidebar to reveal view (delayed)');

          // Try focusing the side bar to encourage VS Code to materialize the view
          try { await vscode.commands.executeCommand('workbench.action.focusSideBar'); outputChannel?.appendLine('[DEBUG] focused sidebar'); } catch (e) { outputChannel?.appendLine('[DEBUG] focusSideBar failed: ' + String(e)); }

          // Also try any generic openView command if present
          const openViewCmd = matches.find(c => c.includes('openView') || c.includes('views.openView'));
          if (openViewCmd) {
            try {
              await vscode.commands.executeCommand(openViewCmd, 'enohacker.sidebarView');
              outputChannel?.appendLine('[DEBUG] executed openView command: ' + openViewCmd);
            } catch (e) { outputChannel?.appendLine('[DEBUG] openViewCmd failed: ' + String(e)); }
          }
        } catch (e) {
          outputChannel?.appendLine('[WARN] delayed reveal sequence failed: ' + String(e));
        }
      }, 600);
    } catch (e) {
      outputChannel?.appendLine('[WARN] failed to invoke enohacker.showSidebar: ' + String(e));
    }
  } catch (err) {
    outputChannel?.appendLine('[ERROR] activation failed: ' + String(err));
    try { vscode.window.showErrorMessage('EnoHacker activation failed: ' + String(err)); } catch {}
  }
}

class EnoHackerViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agentProc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private isStarting = false;

  // 模拟流式输出时使用的定时器句柄
  private simTimers: NodeJS.Timeout[] = [];
  private simActive = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    outputChannel?.appendLine('[INFO] resolveWebviewView called');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    webviewView.webview.html = buildSidebarHtml(this.context, webviewView.webview);
    outputChannel?.appendLine('[INFO] webview.html set');

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      outputChannel?.appendLine('[INFO] webview message: ' + JSON.stringify(msg));
      switch (msg.command) {
        case 'ready':
          // nop
          break;
        case 'prompt':
          if (LAYOUT_ONLY) {
            this.simulateReply(msg.text || '');
          } else {
            await this.startAgentIfNeeded();
            this.sendToAgent({ type: 'prompt', message: msg.text });
          }
          break;
        case 'abort':
          if (LAYOUT_ONLY) {
            this.abortSimulation();
          } else {
            this.sendToAgent({ type: 'abort' });
          }
          break;
        case 'clear':
          this.postToWebview({ type: 'clear' });
          break;
        default:
          console.warn('Unknown message from webview', msg);
      }
    });

    webviewView.onDidDispose(() => {
      outputChannel?.appendLine('[INFO] webviewView disposed');
      // 清理模拟定时器
      this.abortSimulation();
      // keep process alive across hides; optionally kill it here
    });
  }

  private postToWebview(obj: any) {
    try { this.view?.webview.postMessage(obj); } catch (e) { console.warn('post failed', e); }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return buildSidebarHtml(this.context, webview);
  }

  private async startAgentIfNeeded() {
    if (this.agentProc) return;
    if (this.isStarting) return;
    this.isStarting = true;

    // Attempt to locate the local pi CLI in the workspace (relative path)
    // Adjust this path if you installed pi via npm or elsewhere
    const cliPath = path.join(this.context.extensionPath, '..', 'pi-mono', 'packages', 'coding-agent', 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      this.postToWebview({ type: 'error', message: `pi CLI not found at ${cliPath}. Install @mariozechner/pi-coding-agent or adjust path.` });
      this.isStarting = false;
      return;
    }

    try {
      this.agentProc = spawn('node', [cliPath, '--mode', 'rpc', '--no-session'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.agentProc.stderr?.on('data', (b) => {
        const s = b.toString();
        console.warn('agent stderr:', s);
      });

      this.rl = readline.createInterface({ input: this.agentProc.stdout! });
      this.rl.on('line', (line) => this.onAgentStdout(line));

      this.agentProc.on('exit', (code) => {
        this.postToWebview({ type: 'error', message: `pi process exited with code ${code}` });
        this.agentProc = undefined;
      });

      this.postToWebview({ type: 'info', message: 'pi RPC process started' });
    } catch (err) {
      this.postToWebview({ type: 'error', message: 'Failed to start pi: ' + String(err) });
      this.agentProc = undefined;
    } finally {
      this.isStarting = false;
    }
  }

  private onAgentStdout(line: string) {
    let data: any;
    try { data = JSON.parse(line); } catch { return; }

    if (data.type === 'message_update' && data.assistantMessageEvent && data.assistantMessageEvent.type === 'text_delta') {
      const delta = data.assistantMessageEvent.delta as string;
      this.postToWebview({ type: 'delta', delta });
      return;
    }

    if (data.type === 'agent_start') { this.postToWebview({ type: 'agent_start' }); return; }
    if (data.type === 'agent_end') { this.postToWebview({ type: 'agent_end' }); return; }
    if (data.type === 'tool_execution_start') { this.postToWebview({ type: 'tool_start', tool: data.toolName }); return; }
    if (data.type === 'tool_execution_end') { this.postToWebview({ type: 'tool_end', result: data.result }); return; }

    // generic debug
    // this.postToWebview({ type: 'debug', payload: data });
  }

  private sendToAgent(obj: any) {
    if (!this.agentProc || !this.agentProc.stdin) {
      this.postToWebview({ type: 'error', message: 'Agent process not started' });
      return;
    }
    try {
      this.agentProc.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.postToWebview({ type: 'error', message: 'Failed to send to agent: ' + String(err) });
    }
  }

  // 模拟回复（流式）
  private simulateReply(text: string) {
    this.abortSimulation();
    this.simActive = true;
    this.postToWebview({ type: 'start_prompt' });

    const reply = `模拟助手：已收到你的消息：${text}\n\n这是演示流式输出，用于调试界面布局。\n\n示例代码：\nconsole.log('hello world');\n\n谢谢！`;
    let idx = 0;
    const chunkSize = 40;
    const sendChunk = () => {
      if (!this.simActive) return;
      if (idx >= reply.length) {
        this.postToWebview({ type: 'agent_end' });
        this.postToWebview({ type: 'prompt_done' });
        this.simActive = false;
        return;
      }
      const delta = reply.slice(idx, idx + chunkSize);
      idx += chunkSize;
      this.postToWebview({ type: 'delta', delta });
      const t = setTimeout(sendChunk, 120);
      this.simTimers.push(t);
    };
    // 首次延迟以便 UI 能先渲染用户输入行
    const first = setTimeout(sendChunk, 200);
    this.simTimers.push(first);
  }

  private abortSimulation() {
    this.simActive = false;
    for (const t of this.simTimers) { try { clearTimeout(t); } catch {} }
    this.simTimers = [];
    this.postToWebview({ type: 'aborted' });
  }
}

export function deactivate() {
  // nothing
}
