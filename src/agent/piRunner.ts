import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

// Small quoting helpers for constructing shell commands when launching via a shell
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function quotePowerShell(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * PiRunner: encapsulates starting pi in RPC mode in two ways:
 *  - headless RPC (startHiddenRpc): spawn a background process and parse newline-delimited JSON events
 *    from stdout. Events parsed from this RPC process are emitted via onEvent and are intended for
 *    programmatic consumption by the sidebar webview.
 *  - terminal-backed (startTerminal): spawn pi inside a VS Code Pseudoterminal so the user can
 *    interact with the CLI. Terminal output is written only to the terminal and is NOT emitted as
 *    parsed events. This ensures the sidebar webview communicates only with the headless RPC process.
 *
 * Launch strategy:
 * 1) Prefer a compiled CLI (dist/cli.js) bundled in the extension's node_modules or resolvable via require.resolve
 * 2) If not available, detect a development TypeScript source (packages/coding-agent/src/cli.ts) and run it
 *    via `npx tsx <path>` (mirrors ai.sh behaviour for development).
 * 3) Do NOT prompt to install a global `pi` on PATH. Users should either rely on the bundled CLI (production)
 *    or have the dev workspace available (development). Optionally enohacker.piPath can point to a specific file/dir.
 */
export class PiRunner {
  private context: vscode.ExtensionContext;
  private output?: vscode.OutputChannel;

  // Separate processes for RPC and terminal modes
  private rpcProc?: ChildProcessWithoutNullStreams;
  private rpcBuffer = '';
  private isStartingRpc = false;

  private terminalProc?: ChildProcessWithoutNullStreams; // child process running inside the pty
  private terminal?: vscode.Terminal; // the VS Code Terminal object
  private isStartingTerminal = false;

  // Events are only emitted for the RPC (headless) process
  private eventEmitter = new vscode.EventEmitter<any>();
  public readonly onEvent = this.eventEmitter.event;

  // Raw lines from RPC stderr/unparsed can be emitted separately if needed
  private rawEmitter = new vscode.EventEmitter<string>();
  public readonly onRaw = this.rawEmitter.event;

  constructor(context: vscode.ExtensionContext, output?: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
  }

  // Try to resolve the pi CLI path. Prefer an explicit enohacker.piPath configuration if present,
  // then bundled package under extension/node_modules, then general require.resolve, then the dev workspace layout.
  // This function intentionally only returns a candidate path (JS or TS). The caller decides how to run it.
  private resolveCliPathCandidate(): string | undefined {
    // 0) Respect explicit configuration if provided (enohacker.piPath)
    try {
      const cfg = vscode.workspace.getConfiguration('enohacker');
      let configured = cfg.get<string>('piPath') || '';
      if (configured) {
        // Expand ~ to home
        if (configured.startsWith('~')) {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          configured = path.join(home, configured.slice(1));
        }
        // Resolve relative paths against the workspace root (or cwd)
        if (!path.isAbsolute(configured)) {
          const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
          const base = ws ? ws.uri.fsPath : process.cwd();
          configured = path.resolve(base, configured);
        }

        if (fs.existsSync(configured)) {
          const stat = fs.statSync(configured);
          if (stat.isDirectory()) {
            const candidate1 = path.join(configured, 'dist', 'cli.js');
            const candidate2 = path.join(configured, 'cli.js');
            const candidate3 = path.join(configured, 'src', 'cli.ts');
            if (fs.existsSync(candidate1)) return candidate1;
            if (fs.existsSync(candidate2)) return candidate2;
            if (fs.existsSync(candidate3)) return candidate3;
          } else {
            return configured;
          }
        }
      }
    } catch (e) {
      // ignore configuration read errors
    }

    // 1) Check extension's node_modules where the package would be when bundled in the VSIX
    const nmPath = path.join(this.context.extensionPath, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
    if (fs.existsSync(nmPath)) return nmPath;

    // 2) Try require.resolve as a more general resolution (honors NODE_PATH / require paths)
    try {
      const resolved = require.resolve('@mariozechner/pi-coding-agent/dist/cli.js', { paths: [this.context.extensionPath, process.cwd()] });
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch (e) {
      // ignore
    }

    // 3) Fallback to adjacent pi-mono workspace layout used during development (compiled)
    const devDist = path.join(this.context.extensionPath, '..', 'pi-mono', 'packages', 'coding-agent', 'dist', 'cli.js');
    if (fs.existsSync(devDist)) return devDist;

    // 4) Check for TypeScript source used in development and supported by ai.sh
    const devSrc = path.join(this.context.extensionPath, '..', 'pi-mono', 'packages', 'coding-agent', 'src', 'cli.ts');
    if (fs.existsSync(devSrc)) return devSrc;

    // 5) Try workspace-local node_modules (if extension is used inside monorepo)
    try {
      const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (ws) {
        const wsNm = path.join(ws.uri.fsPath, 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');
        if (fs.existsSync(wsNm)) return wsNm;
        const wsSrc = path.join(ws.uri.fsPath, 'packages', 'coding-agent', 'src', 'cli.ts');
        if (fs.existsSync(wsSrc)) return wsSrc;
      }
    } catch (e) {
      // ignore
    }

    return undefined;
  }

  // Expose candidate resolver for external consumers (extension activation, terminal profile provider)
  public getCliPathCandidate(): string | undefined {
    try { return this.resolveCliPathCandidate(); } catch (e) { return undefined; }
  }

  // Start a headless RPC instance and emit parsed events via onEvent
  public async startHiddenRpc(): Promise<void> {
    if (this.rpcProc) return;
    if (this.isStartingRpc) return;
    this.isStartingRpc = true;

    const candidate = this.resolveCliPathCandidate();
    if (!candidate) {
      this.output?.appendLine('[ERROR] pi CLI not found (resolve failed)');
      this.isStartingRpc = false;
      throw new Error('pi CLI not found');
    }

    // Decide how to run the candidate: JS (node) or TS (npx tsx)
    const nodeBin = process.execPath || 'node';
    let launcher: string;
    let args: string[] = [];

    if (candidate.endsWith('.ts')) {
      // Use npx tsx to run the TypeScript source (mirrors ai.sh behaviour in development)
      launcher = 'npx';
      args = ['tsx', candidate, '--mode', 'rpc', '--no-session'];
      this.output?.appendLine('[INFO] starting pi rpc headless via `npx tsx` (' + candidate + ')');
    } else {
      launcher = nodeBin;
      args = [candidate, '--mode', 'rpc', '--no-session'];
      this.output?.appendLine('[INFO] starting pi rpc headless via node (' + candidate + ')');
    }

    this.rpcProc = spawn(launcher, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.context.extensionPath,
      env: { ...process.env }
    });

    this.rpcProc.stderr?.on('data', (b) => {
      const s = b.toString();
      this.output?.appendLine('[pi stderr] ' + s);
      // Emit raw stderr from RPC process for debugging if listeners want it
      this.rawEmitter.fire(s);
    });

    this.rpcProc.stdout?.on('data', (b) => this.handleRpcStdoutChunk(b.toString()));

    this.rpcProc.on('exit', (code) => {
      this.output?.appendLine('[INFO] pi (rpc) process exited: ' + String(code));
      this.eventEmitter.fire({ type: 'rpc_process_exit', code });
      this.rpcProc = undefined;
    });

    this.isStartingRpc = false;
  }

  // Start a terminal-backed pi instance. Terminal output is not emitted as parsed events.
  public async startTerminal(name = 'pi (enohacker)', options?: { noEnv?: boolean; args?: string[]; integrated?: boolean }) {
    if (this.terminalProc) {
      this.output?.appendLine('[WARN] terminal-backed pi already running; skipping new terminal spawn');
      return;
    }
    if (this.isStartingTerminal) return;
    this.isStartingTerminal = true;

    // Resolve candidate (may be JS or TS)
    let candidate = this.resolveCliPathCandidate();
    // If resolveCliPathCandidate didn't find anything, we will prefer pointing user to settings rather than trying a global 'pi'
    if (!candidate) {
      this.output?.appendLine('[WARN] pi CLI not found via resolve; will try development sources before giving up');
      const devSrc = path.join(this.context.extensionPath, '..', 'pi-mono', 'packages', 'coding-agent', 'src', 'cli.ts');
      if (fs.existsSync(devSrc)) candidate = devSrc;
    }

    const nodeBin = process.execPath || 'node';

    const execArgs = options?.args ?? [];

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        this.output?.appendLine(`[INFO] spawning pi in terminal (prefer bundled CLI or development source)`);

        // Prepare environment; optionally unset sensitive API keys like ai.sh does when noEnv is requested
        const env = { ...process.env } as any;
        if (options && options.noEnv) {
          const toUnset = [
            'ANTHROPIC_API_KEY','ANTHROPIC_OAUTH_TOKEN','OPENAI_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','CEREBRAS_API_KEY','XAI_API_KEY','OPENROUTER_API_KEY','ZAI_API_KEY','MISTRAL_API_KEY','MINIMAX_API_KEY','MINIMAX_CN_API_KEY','AI_GATEWAY_API_KEY','OPENCODE_API_KEY','COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','AWS_PROFILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_REGION','AWS_DEFAULT_REGION','AWS_BEARER_TOKEN_BEDROCK','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_WEB_IDENTITY_TOKEN_FILE','AZURE_OPENAI_API_KEY','AZURE_OPENAI_BASE_URL','AZURE_OPENAI_RESOURCE_NAME'
          ];
          for (const k of toUnset) { delete env[k]; }
          this.output?.appendLine('[INFO] spawning terminal with sensitive env vars unset (noEnv=true)');
        }

        // Helper to wire a spawned process to the terminal emitters
        const wireProc = (p: ChildProcessWithoutNullStreams) => {
          p.stdout?.on('data', (b) => writeEmitter.fire(b.toString()));
          p.stderr?.on('data', (b) => writeEmitter.fire(b.toString()));
          p.on('exit', (code) => {
            closeEmitter.fire(code ?? 0);
            this.output?.appendLine('[INFO] pi (terminal) process exited: ' + String(code));
            if (this.terminalProc === p) this.terminalProc = undefined;
          });
          p.on('error', (err: any) => {
            // child_process.spawn does not throw for ENOENT — it emits an 'error' event
            this.output?.appendLine('[ERROR] pi terminal spawn error: ' + String(err));
            writeEmitter.fire('Failed to start pi terminal: ' + String(err) + '\n');
            if (this.terminalProc === p) this.terminalProc = undefined;
          });
        };

        // If we have a candidate, run it either via node (JS) or npx tsx (TS). Do NOT prompt for global installs.
        if (candidate && fs.existsSync(candidate)) {
          const ext = path.extname(candidate).toLowerCase();
          if (ext === '.ts') {
            this.output?.appendLine('[INFO] using TypeScript CLI at ' + candidate + ' — launching via `npx tsx`');
            try {
              const p = spawn('npx', ['tsx', candidate, ...execArgs], { stdio: ['pipe','pipe','pipe'], cwd: this.context.extensionPath, env });
              this.terminalProc = p;
              wireProc(p);
            } catch (err) {
              this.output?.appendLine('[ERROR] failed to spawn `npx tsx` for TS CLI: ' + String(err));
              writeEmitter.fire('Failed to start pi terminal: ' + String(err));
            }
          } else {
            // Assume JS
            this.output?.appendLine('[INFO] using CLI at ' + candidate + ' — launching via node');
            try {
              const p = spawn(nodeBin, [candidate, ...execArgs], { stdio: ['pipe','pipe','pipe'], cwd: this.context.extensionPath, env });
              this.terminalProc = p;
              wireProc(p);
            } catch (err) {
              this.output?.appendLine('[ERROR] failed to spawn node CLI: ' + String(err));
              writeEmitter.fire('Failed to start pi terminal: ' + String(err));
            }
          }

        } else {
          // No candidate found: inform user and offer a shortcut to settings. We intentionally do NOT try to install globally.
          const msg = 'pi CLI not found. Configure the development workspace or include @mariozechner/pi-coding-agent in the extension node_modules.';
          this.output?.appendLine('[ERROR] ' + msg);
          writeEmitter.fire(msg + '\n');
          vscode.window.showInformationMessage(msg, 'Open Settings').then((choice) => {
            if (choice === 'Open Settings') {
              vscode.commands.executeCommand('workbench.action.openSettings', 'enohacker.piPath');
            }
          });
        }
      },

      close: () => {
        try { this.terminalProc?.kill(); } catch (e) { /* ignore */ }
        this.terminalProc = undefined;
      },

      handleInput: (data: string) => {
        try {
          if (this.terminalProc && this.terminalProc.stdin.writable) {
            this.terminalProc.stdin.write(data);
          }
        } catch (e) {
          // ignore
        }
      }
    };

    // If the caller requested an integrated (user-visible) terminal and we have a candidate,
    // prefer creating a terminal using shellPath/shellArgs so the command is not printed into the
    // terminal by using terminal.sendText(...). This uses the terminal's process creation semantics
    // to run the CLI directly (no visible command string).
    if (options && options.integrated) {
      if (candidate && fs.existsSync(candidate)) {
        // Prepare environment for integrated terminal (optionally unset sensitive env vars)
        const termEnv: { [key: string]: string | undefined } = { ...process.env } as any;
        if (options.noEnv) {
          const toUnset = [
            'ANTHROPIC_API_KEY','ANTHROPIC_OAUTH_TOKEN','OPENAI_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','CEREBRAS_API_KEY','XAI_API_KEY','OPENROUTER_API_KEY','ZAI_API_KEY','MISTRAL_API_KEY','MINIMAX_API_KEY','MINIMAX_CN_API_KEY','AI_GATEWAY_API_KEY','OPENCODE_API_KEY','COPILOT_GITHUB_TOKEN','GH_TOKEN','GITHUB_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','AWS_PROFILE','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_REGION','AWS_DEFAULT_REGION','AWS_BEARER_TOKEN_BEDROCK','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_WEB_IDENTITY_TOKEN_FILE','AZURE_OPENAI_API_KEY','AZURE_OPENAI_BASE_URL','AZURE_OPENAI_RESOURCE_NAME'
          ];
          for (const k of toUnset) { delete termEnv[k]; }
          this.output?.appendLine('[INFO] launching integrated terminal with sensitive env vars unset (noEnv=true)');
        }

        const ext = path.extname(candidate).toLowerCase();
        if (ext === '.ts') {
          // Run via npx tsx using the user's shell so npx is resolved from the shell environment.
          if (process.platform === 'win32') {
            const cmd = `npx tsx ${quotePowerShell(candidate)} ${execArgs.map(quotePowerShell).join(' ')}`;
            this.output?.appendLine('[INFO] creating integrated terminal: shellPath=powershell.exe, shellArgs=' + JSON.stringify(['-NoProfile', '-Command', cmd]));
            const term = vscode.window.createTerminal({ name, shellPath: 'powershell.exe', shellArgs: ['-NoProfile', '-Command', cmd], env: termEnv, cwd: this.context.extensionPath });
            term.show(true);
            this.terminal = term;
            this.isStartingTerminal = false;
            return;
          } else {
            const cmd = `npx tsx ${shellEscape(candidate)} ${execArgs.map(shellEscape).join(' ')}`;
            this.output?.appendLine('[INFO] creating integrated terminal: shellPath=/bin/sh, shellArgs=' + JSON.stringify(['-lc', cmd]));
            const term = vscode.window.createTerminal({ name, shellPath: '/bin/sh', shellArgs: ['-lc', cmd], env: termEnv, cwd: this.context.extensionPath });
            term.show(true);
            this.terminal = term;
            this.isStartingTerminal = false;
            return;
          }
        } else {
          // JS: run node directly as the terminal's process (no sendText)
          const term = vscode.window.createTerminal({ name, shellPath: nodeBin, shellArgs: [candidate, ...execArgs], env: termEnv, cwd: this.context.extensionPath });
          term.show(true);
          this.terminal = term;

          this.isStartingTerminal = false;
          return;
        }
      } else {
        const msg = 'pi CLI not found for integrated terminal. Configure the development workspace or include @mariozechner/pi-coding-agent in the extension node_modules.';
        this.output?.appendLine('[ERROR] ' + msg);
        try { vscode.window.showInformationMessage(msg, 'Open Settings').then((choice) => { if (choice === 'Open Settings') { vscode.commands.executeCommand('workbench.action.openSettings', 'enohacker.piPath'); } }); } catch {}
      }
    }

    // create the VS Code terminal backed by our pty and keep a reference to it
    this.terminal = vscode.window.createTerminal({ name, pty });
    this.terminal.show(true);

    this.isStartingTerminal = false;
  }

  // Stop both RPC and terminal processes
  public stop(): void {
    try {
      if (this.rpcProc) {
        this.rpcProc.kill();
        this.rpcProc = undefined;
      }
    } catch (e) {
      // ignore
    }
    try {
      if (this.terminalProc) {
        this.terminalProc.kill();
        this.terminalProc = undefined;
      }
    } catch (e) {
      // ignore
    }
    try {
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = undefined;
      }
    } catch (e) {}
  }

  public stopRpc(): void {
    try { if (this.rpcProc) { this.rpcProc.kill(); this.rpcProc = undefined; } } catch (e) {}
  }

  public stopTerminal(): void {
    try { if (this.terminalProc) { this.terminalProc.kill(); this.terminalProc = undefined; } } catch (e) {}
    try { if (this.terminal) { this.terminal.dispose(); this.terminal = undefined; } } catch (e) {}
  }

  public sendCommand(obj: any) {
    if (!this.rpcProc || !this.rpcProc.stdin) {
      throw new Error('pi RPC process not running');
    }
    try {
      const line = JSON.stringify(obj) + '\n';
      this.rpcProc.stdin.write(line);
    } catch (e) {
      this.output?.appendLine('[ERROR] failed to write to pi rpc stdin: ' + String(e));
      throw e;
    }
  }

  public sendRaw(text: string) {
    if (!this.rpcProc || !this.rpcProc.stdin) throw new Error('pi RPC process not running');
    this.rpcProc.stdin.write(text);
  }

  // internal: accumulate stdout chunks from RPC process, split into lines, parse JSON lines and emit events
  private handleRpcStdoutChunk(chunk: string) {
    // Emit raw for debugging
    this.rawEmitter.fire(chunk);

    this.rpcBuffer += chunk;
    let idx: number;
    while ((idx = this.rpcBuffer.indexOf('\n')) !== -1) {
      const line = this.rpcBuffer.slice(0, idx).trim();
      this.rpcBuffer = this.rpcBuffer.slice(idx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        this.eventEmitter.fire(parsed);
      } catch (e) {
        // Non-JSON line. Emit as raw so listeners can decide what to do
        this.rawEmitter.fire(line + '\n');
      }
    }
  }
}
