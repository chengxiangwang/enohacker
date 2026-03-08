import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PiRunner } from './agent/piRunner';
import { EnoHackerSidebarProvider } from './view/sidebarView';

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

export function activate(context: vscode.ExtensionContext) {
  // create output channel for debugging
  outputChannel = vscode.window.createOutputChannel('EnoHacker');
  context.subscriptions.push(outputChannel);
  outputChannel?.appendLine('[INFO] activating enohacker extension');

  try {
    // Centralized runner that manages pi process (headless or terminal-backed)
    const runner = new PiRunner(context, outputChannel);

    // Sidebar webview provider (UI agent)
    try {
      const provider = new EnoHackerSidebarProvider(context, runner, outputChannel);
      const disp = vscode.window.registerWebviewViewProvider(EnoHackerSidebarProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true }
      });
      context.subscriptions.push(disp);
      context.subscriptions.push(vscode.commands.registerCommand('enohacker.showSidebar', async () => {
        try { await vscode.commands.executeCommand('workbench.view.extension.enohacker-sidebar'); } catch (e) { /* ignore */ }
      }));
      outputChannel?.appendLine('[INFO] registered sidebar webview provider');
    } catch (e) {
      outputChannel?.appendLine('[WARN] failed to register sidebar webview provider: ' + String(e));
    }

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

export function deactivate() {
  // nothing
}
