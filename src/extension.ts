import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PiRunner } from './agent/piRunner';

// 开发阶段布局优先：默认启用 layout-only 模式，不启动 pi 子进程（便于在 Extension Dev Host 中快速预览界面）
const LAYOUT_ONLY = true;

let outputChannel: vscode.OutputChannel | undefined;

// Shell escape helpers for terminal profile commands
function shellEscape(s: string): string {
  // POSIX single-quote escaping
  return "'" + s.replace(/'/g, "'\\'\''") + "'";
}
function quotePowerShell(s: string): string {
  // PowerShell single-quote literal escaping ('' -> ' inside single quotes)
  return "'" + s.replace(/'/g, "''") + "'";
}

// Helper: build webview HTML for both sidebar webview view and standalone panel
function buildSidebarHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const filePath = path.join(context.extensionPath, 'media', 'sidebar.html');
  let html = '';
  try { html = fs.readFileSync(filePath, 'utf8'); } catch (e) { html = `<body><h3>Sidebar template not found</h3><pre>${String(e)}</pre></body>`; }

  const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'sidebar.js')));
  const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'sidebar.css')));

  const logoUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'copilot.png')));
  const fontUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'copilot.woff')));
  const avatarUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'copilot.png')));

  // markdown + highlight.js assets
  const markedUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'marked.umd.js')));
  const hljsCoreUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-core.js')));
  const hljsJsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-javascript.js')));
  const hljsTsUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-typescript.js')));
  const hljsPyUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-python.js')));
  const hljsBashUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-bash.js')));
  const hljsJsonUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-json.js')));
  const hljsXmlUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-xml.js')));
  const hljsCssLight = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-vs.css')));
  const hljsCssDark = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'hljs-github-dark.css')));

  html = html.replace(/\{\{SCRIPT_URI\}\}/g, String(scriptUri));
  html = html.replace(/\{\{STYLE_URI\}\}/g, String(styleUri));
  html = html.replace(/\{\{LOGO_URI\}\}/g, String(logoUri));
  html = html.replace(/\{\{FONT_URI\}\}/g, String(fontUri));
  html = html.replace(/\{\{AVATAR_URI\}\}/g, String(avatarUri));

  html = html.replace(/\{\{MARKED_URI\}\}/g, String(markedUri));
  html = html.replace(/\{\{HLJS_CORE_URI\}\}/g, String(hljsCoreUri));
  html = html.replace(/\{\{HLJS_JS_URI\}\}/g, String(hljsJsUri));
  html = html.replace(/\{\{HLJS_TS_URI\}\}/g, String(hljsTsUri));
  html = html.replace(/\{\{HLJS_PY_URI\}\}/g, String(hljsPyUri));
  html = html.replace(/\{\{HLJS_BASH_URI\}\}/g, String(hljsBashUri));
  html = html.replace(/\{\{HLJS_JSON_URI\}\}/g, String(hljsJsonUri));
  html = html.replace(/\{\{HLJS_XML_URI\}\}/g, String(hljsXmlUri));
  html = html.replace(/\{\{HLJS_CSS_LIGHT_URI\}\}/g, String(hljsCssLight));
  html = html.replace(/\{\{HLJS_CSS_DARK_URI\}\}/g, String(hljsCssDark));

  return html;
}

export function activate(context: vscode.ExtensionContext) {
  // create output channel for debugging
  outputChannel = vscode.window.createOutputChannel('EnoHacker');
  context.subscriptions.push(outputChannel);
  outputChannel?.appendLine('[INFO] activating enohacker extension');

  try {
    // Centralized runner that manages pi process (headless or terminal-backed)
    const runner = new PiRunner(context, outputChannel);

    const provider = new EnoHackerViewProvider(context, runner);
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

    // Command to spawn a terminal-backed pi instance (visible to the user)
    context.subscriptions.push(vscode.commands.registerCommand('enohacker.openPiTerminal', async () => {
      try {
        outputChannel?.appendLine('[INFO] openPiTerminal invoked');
        // Prefer launching in an integrated VS Code terminal so the user sees the CLI directly.
        await runner.startTerminal('pi (enohacker)', { integrated: true });
      } catch (e) {
        outputChannel?.appendLine('[ERROR] openPiTerminal failed: ' + String(e));
        try { vscode.window.showErrorMessage('Failed to open pi terminal: ' + String(e)); } catch {}
      }
    }));

    // Command to start a headless RPC process (used by the webview integration)
    context.subscriptions.push(vscode.commands.registerCommand('enohacker.startPi', async () => {
      try {
        outputChannel?.appendLine('[INFO] startPi invoked');
        await runner.startHiddenRpc();
        vscode.window.showInformationMessage('pi (RPC) started');
      } catch (e) {
        outputChannel?.appendLine('[ERROR] startPi failed: ' + String(e));
        try { vscode.window.showErrorMessage('Failed to start pi: ' + String(e)); } catch {}
      }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('enohacker.stopPi', async () => {
      try {
        outputChannel?.appendLine('[INFO] stopPi invoked');
        runner.stop();
      } catch (e) {
        outputChannel?.appendLine('[ERROR] stopPi failed: ' + String(e));
      }
    }));

    // Register a terminal profile provider so "EnoHacker CLI" appears in the integrated terminal + dropdown
    try {
      const profileId = 'enohacker-cli';
      const candidate = runner.getCliPathCandidate ? runner.getCliPathCandidate() : undefined;

      if (candidate && fs.existsSync(candidate)) {
        const provider = {
          provideTerminalProfile: (token: vscode.CancellationToken) => {
            try {
              const execArgs: string[] = [];
              const ext = path.extname(candidate).toLowerCase();
              let opts: vscode.TerminalOptions;

              if (ext === '.js') {
                opts = {
                  name: 'EnoHacker CLI',
                  shellPath: process.execPath,
                  shellArgs: [candidate],
                  cwd: context.extensionPath,
                  env: { ...process.env }
                };
              } else if (ext === '.ts') {
                if (process.platform === 'win32') {
                  const cmd = `npx tsx ${quotePowerShell(candidate)} ${execArgs.map(quotePowerShell).join(' ')}`;
                  opts = {
                    name: 'EnoHacker CLI',
                    shellPath: 'powershell.exe',
                    shellArgs: ['-NoProfile', '-Command', cmd],
                    cwd: context.extensionPath,
                    env: { ...process.env }
                  };
                } else {
                  const cmd = `npx tsx ${shellEscape(candidate)} ${execArgs.map(shellEscape).join(' ')}`;
                  opts = {
                    name: 'EnoHacker CLI',
                    shellPath: '/bin/sh',
                    shellArgs: ['-lc', cmd],
                    cwd: context.extensionPath,
                    env: { ...process.env }
                  };
                }
              } else {
                // Unknown extension: fallback to node
                opts = {
                  name: 'EnoHacker CLI',
                  shellPath: process.execPath,
                  shellArgs: [candidate],
                  cwd: context.extensionPath,
                  env: { ...process.env }
                };
              }

              return new vscode.TerminalProfile(opts);
            } catch (e) {
              outputChannel?.appendLine('[WARN] terminal profile provider error: ' + String(e));
              const opts: vscode.TerminalOptions = { name: 'EnoHacker CLI (error)', shellPath: process.execPath, shellArgs: ['-e', 'console.log("EnoHacker profile error")'], cwd: context.extensionPath };
              return new vscode.TerminalProfile(opts);
            }
          }
        };

        const disp = vscode.window.registerTerminalProfileProvider(profileId, provider as any);
        context.subscriptions.push(disp);
        outputChannel?.appendLine('[INFO] registered terminal profile provider: ' + profileId + ' (candidate: ' + candidate + ')');
      } else {
        outputChannel?.appendLine('[INFO] CLI candidate not found, skipping terminal profile registration (candidate: ' + String(candidate) + ')');
      }
    } catch (e) {
      outputChannel?.appendLine('[WARN] registerTerminalProfileProvider failed: ' + String(e));
    }

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
  private simTimers: NodeJS.Timeout[] = [];
  private simActive = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly runner: PiRunner) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    outputChannel?.appendLine('[INFO] resolveWebviewView called');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    webviewView.webview.html = buildSidebarHtml(this.context, webviewView.webview);
    outputChannel?.appendLine('[INFO] webview.html set');

    // Subscribe to pi runner events and forward to the webview
    try {
      const disp = this.runner.onEvent((evt: any) => {
        try {
          // Forward streaming text deltas specially
          if (evt && evt.type === 'message_update' && evt.assistantMessageEvent && evt.assistantMessageEvent.type === 'text_delta') {
            const delta = evt.assistantMessageEvent.delta as string;
            this.postToWebview({ type: 'delta', delta });
            return;
          }

          if (evt && evt.type === 'agent_start') { this.postToWebview({ type: 'agent_start' }); return; }
          if (evt && evt.type === 'agent_end') { this.postToWebview({ type: 'agent_end' }); return; }
          if (evt && evt.type === 'tool_execution_start') { this.postToWebview({ type: 'tool_start', tool: evt.toolName }); return; }
          if (evt && evt.type === 'tool_execution_end') { this.postToWebview({ type: 'tool_end', result: evt.result }); return; }

          // Generic: forward the event for debugging/UI
          this.postToWebview({ type: 'event', payload: evt });
        } catch (e) {
          // ignore per-event errors
        }
      });
      this.context.subscriptions.push(disp);
    } catch (e) {
      outputChannel?.appendLine('[WARN] failed to subscribe to runner events: ' + String(e));
    }

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
            try {
              await this.runner.startHiddenRpc();
              this.runner.sendCommand({ type: 'prompt', message: msg.text });
            } catch (err) {
              outputChannel?.appendLine('[ERROR] failed to send prompt to pi: ' + String(err));
              this.postToWebview({ type: 'error', message: String(err) });
            }
          }
          break;
        case 'abort':
          if (LAYOUT_ONLY) {
            this.abortSimulation();
          } else {
            try {
              this.runner.sendCommand({ type: 'abort' });
            } catch (err) {
              outputChannel?.appendLine('[ERROR] failed to send abort to pi: ' + String(err));
            }
          }
          break;
        case 'clear':
          this.postToWebview({ type: 'clear' });
          break;
        case 'openTerminalMode':
          // Launch pi in an integrated terminal (terminal-backed pty) via the unified openPiTerminal command
          try {
            await vscode.commands.executeCommand('enohacker.openPiTerminal');
            this.postToWebview({ type: 'info', message: 'Terminal launched' });
          } catch (err) {
            outputChannel?.appendLine('[ERROR] failed to launch terminal pi via command: ' + String(err));
            this.postToWebview({ type: 'error', message: String(err) });
          }
          break;
        case 'copyToClipboard':
          try {
            const text = msg.text || '';
            await vscode.env.clipboard.writeText(text);
            this.postToWebview({ type: 'info', message: 'Copied to clipboard' });
            outputChannel?.appendLine('[INFO] copied message to clipboard (length=' + String((msg.text || '').length) + ')');
          } catch (err) {
            outputChannel?.appendLine('[ERROR] copyToClipboard failed: ' + String(err));
            this.postToWebview({ type: 'error', message: 'Copy failed: ' + String(err) });
          }
          break;
        case 'openInEditor':
          try {
            const text = msg.text || '';
            const lang = msg.language || undefined;
            const doc = await vscode.workspace.openTextDocument({ content: String(text), language: lang });
            await vscode.window.showTextDocument(doc, { preview: false });
          } catch (err) {
            outputChannel?.appendLine('[ERROR] openInEditor failed: ' + String(err));
            this.postToWebview({ type: 'error', message: 'Open in editor failed: ' + String(err) });
          }
          break;
        case 'saveMessage':
          try {
            const defaultName = msg.filename || 'enohacker-message.txt';
            const suggested = vscode.Uri.file(path.join(this.context.extensionPath, defaultName));
            const uri = await vscode.window.showSaveDialog({ defaultUri: suggested });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.text || '', 'utf8'));
              this.postToWebview({ type: 'info', message: 'Saved to ' + uri.fsPath });
            }
          } catch (err) {
            outputChannel?.appendLine('[ERROR] saveMessage failed: ' + String(err));
            this.postToWebview({ type: 'error', message: 'Save failed: ' + String(err) });
          }
          break;
        case 'exportConversation':
          try {
            const defaultName = msg.filename || 'enohacker-conversation.md';
            const suggested = vscode.Uri.file(path.join(this.context.extensionPath, defaultName));
            const uri = await vscode.window.showSaveDialog({ defaultUri: suggested });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.text || '', 'utf8'));
              this.postToWebview({ type: 'info', message: 'Conversation exported to ' + uri.fsPath });
            }
          } catch (err) {
            outputChannel?.appendLine('[ERROR] exportConversation failed: ' + String(err));
            this.postToWebview({ type: 'error', message: 'Export failed: ' + String(err) });
          }
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
