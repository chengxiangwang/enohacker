import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PiRunner } from '../agent/piRunner';

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\'\''") + "'";
}
function quotePowerShell(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function registerTerminalProfileProvider(
  context: vscode.ExtensionContext,
  runner: PiRunner,
  output?: vscode.OutputChannel,
) {
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
                env: { ...process.env },
              };
            } else if (ext === '.ts') {
              if (process.platform === 'win32') {
                const cmd = `npx tsx ${quotePowerShell(candidate)} ${execArgs.map(quotePowerShell).join(' ')}`;
                opts = {
                  name: 'EnoHacker CLI',
                  shellPath: 'powershell.exe',
                  shellArgs: ['-NoProfile', '-Command', cmd],
                  cwd: context.extensionPath,
                  env: { ...process.env },
                };
              } else {
                const cmd = `npx tsx ${shellEscape(candidate)} ${execArgs.map(shellEscape).join(' ')}`;
                opts = {
                  name: 'EnoHacker CLI',
                  shellPath: '/bin/sh',
                  shellArgs: ['-lc', cmd],
                  cwd: context.extensionPath,
                  env: { ...process.env },
                };
              }
            } else {
              opts = {
                name: 'EnoHacker CLI',
                shellPath: process.execPath,
                shellArgs: [candidate],
                cwd: context.extensionPath,
                env: { ...process.env },
              };
            }

            return new vscode.TerminalProfile(opts);
          } catch (e) {
            output?.appendLine('[WARN] terminal profile provider error: ' + String(e));
            const opts: vscode.TerminalOptions = {
              name: 'EnoHacker CLI (error)',
              shellPath: process.execPath,
              shellArgs: ['-e', 'console.log("EnoHacker profile error")'],
              cwd: context.extensionPath,
            };
            return new vscode.TerminalProfile(opts);
          }
        },
      };

      const disp = vscode.window.registerTerminalProfileProvider(profileId, provider as any);
      context.subscriptions.push(disp);
      output?.appendLine(
        '[INFO] registered terminal profile provider: ' +
          profileId +
          ' (candidate: ' +
          candidate +
          ')',
      );
    } else {
      output?.appendLine(
        '[INFO] CLI candidate not found, skipping terminal profile registration (candidate: ' +
          String(candidate) +
          ')',
      );
    }
  } catch (e) {
    output?.appendLine('[WARN] registerTerminalProfileProvider failed: ' + String(e));
  }
}
