import { existsSync, readFileSync } from 'node:fs';
import { stream } from './exec.ts';
import { paths } from '../paths.ts';

export interface PythonRunOptions {
  args: string[];
  signal?: AbortSignal;
  onProgress?: (pct: number, msg: string) => void;
  onLog?: (line: string) => void;
}

/**
 * Invoke a helper script with the venv interpreter, translating its stderr
 * `@progress {...}` lines into callbacks. Returns whatever the script printed to stdout.
 */
export async function runPython(script: string, opts: PythonRunOptions): Promise<string> {
  if (!existsSync(paths.venvPython)) {
    throw new Error(
      `Python venv missing at ${paths.venvPython}. Run: bash scripts/setup.sh`,
    );
  }
  const scriptPath = paths.script(script);
  if (!existsSync(scriptPath)) throw new Error(`helper script not found: ${scriptPath}`);

  const res = await stream(paths.venvPython, [scriptPath, ...opts.args], {
    signal: opts.signal,
    cwd: paths.python,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    onStderr: (line) => {
      if (line.startsWith('@progress ')) {
        try {
          const { pct, msg } = JSON.parse(line.slice('@progress '.length)) as { pct: number; msg: string };
          opts.onProgress?.(pct, msg ?? '');
          return;
        } catch {
          /* fall through to log */
        }
      }
      opts.onLog?.(line);
    },
  });
  return res.stdout.trim();
}

/**
 * Parse a helper script's JSON result. Prefers the `--out` file (which
 * `common.emit_result` always writes cleanly) and falls back to stdout — ML
 * libraries occasionally leak load chatter onto stdout ahead of the result.
 */
export function readVerdict<T>(outPath: string, stdout: string): T {
  if (existsSync(outPath)) {
    try {
      return JSON.parse(readFileSync(outPath, 'utf8')) as T;
    } catch {
      /* fall through to stdout */
    }
  }
  // last-resort: the result is the final JSON object printed; scan lines from the end
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith('{') && lines[i]!.endsWith('}')) {
      try {
        return JSON.parse(lines[i]!) as T;
      } catch {
        /* keep scanning */
      }
    }
  }
  throw new Error(`helper produced no readable JSON (out: ${outPath || 'none'})`);
}
