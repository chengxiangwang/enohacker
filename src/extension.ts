import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PiRunner } from './agent/piRunner';
import { EnoHackerSidebarProvider } from './view/sidebarView';
import { registerTerminalProfileProvider } from './cli/terminalProfile';

// 开发阶段布局优先：默认启用 layout-only 模式，不启动 pi 子进程（便于在 Extension Dev Host 中快速预览界面）
const LAYOUT_ONLY = false;

let outputChannel: vscode.OutputChannel | undefined;

// NOTE: terminal profile provider moved to `src/cli/terminalProfile.ts`

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
      const disp = vscode.window.registerWebviewViewProvider(
        EnoHackerSidebarProvider.viewType,
        provider,
        {
          // Do NOT retain context when hidden to ensure the webview reloads its HTML/UI each time it becomes visible.
          webviewOptions: { retainContextWhenHidden: false },
        },
      );
      context.subscriptions.push(disp);
      context.subscriptions.push(
        vscode.commands.registerCommand('enohacker.showSidebar', async () => {
          try {
            // When the user requests the sidebar be shown, optionally ensure the headless RPC is started
            if (!LAYOUT_ONLY) {
              outputChannel?.appendLine('[DEBUG] showSidebar: attempting to start hidden RPC');
              try {
                await runner.startHiddenRpc();
              } catch (err) {
                outputChannel?.appendLine(
                  '[WARN] showSidebar startHiddenRpc failed: ' + String(err),
                );
              }
            } else {
              outputChannel?.appendLine(
                '[DEBUG] showSidebar: LAYOUT_ONLY enabled; not starting RPC automatically',
              );
            }

            await vscode.commands.executeCommand('workbench.view.extension.enohacker-sidebar');
          } catch (e) {
            /* ignore */
          }
        }),
      );

      // Expose an explicit command to start the headless RPC (useful in Dev Host)
      context.subscriptions.push(
        vscode.commands.registerCommand('enohacker.startRpc', async () => {
          try {
            outputChannel?.appendLine('[INFO] enohacker.startRpc invoked');
            await runner.startHiddenRpc();
            const pid = runner.getRpcPid();
            outputChannel?.appendLine('[INFO] enohacker.startRpc: pid=' + String(pid));
            try {
              await vscode.window.showInformationMessage(
                'pi RPC started (pid: ' + String(pid) + ')',
              );
            } catch {
              outputChannel?.appendLine('[WARN] failed to show information message for RPC start');
            }
          } catch (e) {
            outputChannel?.appendLine('[ERROR] enohacker.startRpc failed: ' + String(e));
            try {
              await vscode.window.showErrorMessage('Failed to start pi RPC: ' + String(e));
            } catch {}
          }
        }),
      );
      outputChannel?.appendLine('[INFO] registered sidebar webview provider');
    } catch (e) {
      outputChannel?.appendLine('[WARN] failed to register sidebar webview provider: ' + String(e));
    }

    // Command to spawn a terminal-backed pi instance (visible to the user)
    context.subscriptions.push(
      vscode.commands.registerCommand('enohacker.openPiTerminal', async () => {
        try {
          outputChannel?.appendLine('[INFO] openPiTerminal invoked');
          // Prefer launching in an integrated VS Code terminal so the user sees the CLI directly.
          await runner.startTerminal('pi (enohacker)', { integrated: true });
        } catch (e) {
          outputChannel?.appendLine('[ERROR] openPiTerminal failed: ' + String(e));
          try {
            vscode.window.showErrorMessage('Failed to open pi terminal: ' + String(e));
          } catch {}
        }
      }),
    );

    // Register terminal profile provider (moved to separate module)
    try {
      registerTerminalProfileProvider(context, runner, outputChannel);
    } catch (e) {
      outputChannel?.appendLine('[WARN] registerTerminalProfileProvider failed: ' + String(e));
    }
    outputChannel?.appendLine('[INFO] activation complete');

    // Debug: print extension's packageJSON as seen by VS Code
    try {
      const extId = 'cxwang.enohacker';
      const ext = vscode.extensions.getExtension(extId);
      if (ext) {
        const contributes =
          ext.packageJSON && ext.packageJSON.contributes ? ext.packageJSON.contributes : undefined;
        outputChannel?.appendLine(
          '[DEBUG] extension package contributes: ' + JSON.stringify(contributes, null, 2),
        );
      } else {
        outputChannel?.appendLine(
          '[DEBUG] extension not found via vscode.extensions.getExtension("' + extId + '")',
        );
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
          outputChannel?.appendLine(
            '[DEBUG] commands matching view/enohacker: ' + JSON.stringify(matches.slice(0, 20)),
          );

          await vscode.commands.executeCommand('enohacker.showSidebar');
          outputChannel?.appendLine(
            '[INFO] invoked enohacker.showSidebar to reveal view (delayed)',
          );

          // Try focusing the side bar to encourage VS Code to materialize the view
          try {
            await vscode.commands.executeCommand('workbench.action.focusSideBar');
            outputChannel?.appendLine('[DEBUG] focused sidebar');
          } catch (e) {
            outputChannel?.appendLine('[DEBUG] focusSideBar failed: ' + String(e));
          }

          // Also try any generic openView command if present
          const openViewCmd = matches.find(
            c => c.includes('openView') || c.includes('views.openView'),
          );
          if (openViewCmd) {
            try {
              await vscode.commands.executeCommand(openViewCmd, 'enohacker.sidebarView');
              outputChannel?.appendLine('[DEBUG] executed openView command: ' + openViewCmd);
            } catch (e) {
              outputChannel?.appendLine('[DEBUG] openViewCmd failed: ' + String(e));
            }
          }
        } catch (e) {
          outputChannel?.appendLine('[WARN] delayed reveal sequence failed: ' + String(e));
        }
      }, 600);
    } catch (e) {
      outputChannel?.appendLine('[WARN] failed to invoke enohacker.showSidebar: ' + String(e));
    }

    // Ensure RPC/term processes are cleaned up when the extension is deactivated
    try {
      context.subscriptions.push({
        dispose: () => {
          try {
            runner.stop();
          } catch (e) {
            /* ignore */
          }
        },
      });
    } catch (e) {
      outputChannel?.appendLine('[DEBUG] failed to register deactivate cleanup: ' + String(e));
    }
  } catch (err) {
    outputChannel?.appendLine('[ERROR] activation failed: ' + String(err));
    try {
      vscode.window.showErrorMessage('EnoHacker activation failed: ' + String(err));
    } catch {}
  }
}

export function deactivate() {
  // VS Code will dispose context.subscriptions automatically; runner.stop() is registered there
}
