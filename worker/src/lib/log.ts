/* Minimal leveled logger. Worker-side only; the UI gets structured events instead. */

const COLORS = {
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
};

const ts = () => new Date().toISOString().slice(11, 23);

function line(color: keyof typeof COLORS, tag: string, args: unknown[]): void {
  const prefix = `${COLORS.gray}${ts()}${COLORS.reset} ${COLORS[color]}${tag}${COLORS.reset}`;
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export const log = {
  info: (...a: unknown[]) => line('blue', 'info ', a),
  warn: (...a: unknown[]) => line('yellow', 'warn ', a),
  error: (...a: unknown[]) => line('red', 'error', a),
  ok: (...a: unknown[]) => line('green', 'ok   ', a),
  debug: (...a: unknown[]) => {
    if (process.env.DEBUG) line('gray', 'debug', a);
  },
};
