import { spawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly result: RunResult,
  ) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n');
    super(`\`${cmd}\` exited with code ${result.code}\n${tail}`);
    this.name = 'CommandError';
  }
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  /** Max buffered output per stream (bytes). Default 32 MiB. */
  maxBuffer?: number;
}

/** Run a command to completion, buffering output. Rejects only on spawn failure. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: opts.signal,
    };
    const child = spawn(cmd, args, spawnOpts);
    const max = opts.maxBuffer ?? 32 * 1024 * 1024;
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > max) stdout = stdout.slice(-max);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > max) stderr = stderr.slice(-max);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));

    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    }
  });
}

/** Like {@link run} but throws {@link CommandError} on a non-zero exit. Returns stdout. */
export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) throw new CommandError([cmd, ...args].join(' '), res);
  return res.stdout;
}

export interface StreamOptions extends RunOptions {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

/**
 * Run a long-lived command, delivering stdout/stderr a line at a time (for progress parsing).
 * Full output is still buffered and returned. Throws {@link CommandError} on non-zero exit.
 */
export async function stream(cmd: string, args: string[], opts: StreamOptions = {}): Promise<RunResult> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  });

  let stdout = '';
  let stderr = '';

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdout += line + '\n';
      opts.onStdout?.(line);
    });
  }
  if (child.stderr) {
    const rl = createInterface({ input: child.stderr });
    rl.on('line', (line) => {
      stderr += line + '\n';
      opts.onStderr?.(line);
    });
  }

  if (opts.input !== undefined) {
    child.stdin?.write(opts.input);
    child.stdin?.end();
  }

  const result = await new Promise<RunResult>((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });

  if (result.code !== 0 && !opts.signal?.aborted) {
    throw new CommandError([cmd, ...args].join(' '), result);
  }
  return result;
}

/** True if a binary is resolvable on PATH. */
export async function which(bin: string): Promise<string | null> {
  const res = await run(process.platform === 'win32' ? 'where' : 'which', [bin]);
  const first = res.stdout.split('\n')[0]?.trim();
  return res.code === 0 && first ? first : null;
}
