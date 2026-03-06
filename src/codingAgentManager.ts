import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type AgentOutput = {
  type: 'stdout' | 'stderr' | 'exit';
  text?: string;
  code?: number | null;
};

export class CodingAgentManager {
  private child?: cp.ChildProcess;
  private _onOutput = new vscode.EventEmitter<AgentOutput>();
  public readonly onOutput = this._onOutput.event;
  private outputChannel: vscode.OutputChannel;

  constructor(private context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Enohacker AI - coding-agent');
  }

  public dispose() {
    this.stop();
    this._onOutput.dispose();
    this.outputChannel.dispose();
  }

  public isInstalled(): boolean {
    const cfg =
      vscode.workspace.getConfiguration('enohacker-ai').get<string>('codingAgent.path') || '';
    if (cfg && fs.existsSync(cfg)) return true;
    const vendorBase = path.join(
      this.context.extensionPath,
      'vendor',
      'node_modules',
      '@mariozechner',
      'pi-coding-agent'
    );
    return fs.existsSync(vendorBase);
  }

  public resolveCliPath(): string | undefined {
    const cfg =
      vscode.workspace.getConfiguration('enohacker-ai').get<string>('codingAgent.path') || '';
    if (cfg && fs.existsSync(cfg)) {
      return cfg;
    }
    const vendorBase = path.join(
      this.context.extensionPath,
      'vendor',
      'node_modules',
      '@mariozechner',
      'pi-coding-agent'
    );
    const pkgPath = path.join(vendorBase, 'package.json');
    if (!fs.existsSync(pkgPath)) return undefined;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as any;
      let entry = '';
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') entry = pkg.bin;
        else if (pkg.bin['pi']) entry = pkg.bin['pi'];
        else entry = String(Object.values(pkg.bin)[0]);
      } else if (pkg.main) entry = pkg.main;
      if (!entry) return undefined;
      return path.join(path.dirname(pkgPath), entry);
    } catch (err) {
      return undefined;
    }
  }

  public async install(
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = 'npm';
      const args = [
        'install',
        '--prefix',
        'vendor',
        '@mariozechner/pi-coding-agent@latest',
        '--production',
        '--no-audit',
        '--no-fund',
      ];
      this.outputChannel.appendLine(`Running: ${npm} ${args.join(' ')}`);
      const p = cp.spawn(npm, args, { cwd: this.context.extensionPath });
      p.stdout?.on('data', (d) => {
        const s = d.toString();
        this.outputChannel.append(s);
        this._onOutput.fire({ type: 'stdout', text: s });
      });
      p.stderr?.on('data', (d) => {
        const s = d.toString();
        this.outputChannel.appendLine('[ERR] ' + s);
        this._onOutput.fire({ type: 'stderr', text: s });
      });
      p.on('error', (err) => {
        this.outputChannel.appendLine('install error: ' + String(err));
        reject(err);
      });
      p.on('close', (code) => {
        this.outputChannel.appendLine('npm install exit ' + code);
        this._onOutput.fire({ type: 'exit', code });
        if (code === 0) resolve();
        else reject(new Error('npm install failed: ' + code));
      });
    });
  }

  public start(cliArgs: string[] = [], useTerminal = false) {
    if (this.child) {
      vscode.window.showInformationMessage('coding-agent 已在运行');
      return;
    }
    const entry = this.resolveCliPath();
    if (!entry) {
      vscode.window.showErrorMessage(
        'coding-agent 未安装，请先通过侧边栏或命令安装（Install Coding Agent）。'
      );
      return;
    }

    if (useTerminal) {
      // Run in integrated terminal
      const nodePath = process.execPath;
      const cmd = `${this.quote(nodePath)} ${this.quote(entry)} ${cliArgs
        .map((a) => this.quote(a))
        .join(' ')}`.trim();
      const term = vscode.window.createTerminal({ name: 'Enohacker AI - coding-agent' });
      term.sendText(cmd);
      term.show();
      this._onOutput.fire({ type: 'stdout', text: `Started in terminal: ${cmd}\n` });
      return;
    }

    // spawn (programmatic) mode
    const node = process.execPath;
    this.outputChannel.appendLine(
      `Starting coding-agent with: ${node} ${entry} ${cliArgs.join(' ')}`
    );
    try {
      this.child = cp.spawn(node, [entry, ...cliArgs], {
        cwd: path.dirname(entry),
        env: process.env,
      });
    } catch (err) {
      vscode.window.showErrorMessage('启动 coding-agent 失败: ' + String(err));
      return;
    }
    this.child.stdout?.on('data', (d) => {
      const s = d.toString();
      this.outputChannel.append(s);
      this._onOutput.fire({ type: 'stdout', text: s });
    });
    this.child.stderr?.on('data', (d) => {
      const s = d.toString();
      this.outputChannel.appendLine('[ERR] ' + s);
      this._onOutput.fire({ type: 'stderr', text: s });
    });
    this.child.on('close', (code) => {
      this.outputChannel.appendLine('coding-agent exited ' + code);
      this._onOutput.fire({ type: 'exit', code });
      this.child = undefined;
    });
    this.child.on('error', (err) => {
      this.outputChannel.appendLine('coding-agent error: ' + String(err));
      this._onOutput.fire({ type: 'stderr', text: String(err) });
    });
  }

  public stop() {
    if (!this.child) {
      vscode.window.showInformationMessage('coding-agent 没有在运行');
      return;
    }
    try {
      this.child.kill();
    } catch (err) {
      // ignore
    }
    this.child = undefined;
    this._onOutput.fire({ type: 'stdout', text: 'Process killed\n' });
  }

  private quote(s: string) {
    if (!s) return '""';
    if (/\s/.test(s)) return `"${s}"`;
    return s;
  }
}
