/**
 * Render fresh videos the way the daily poster does (games skip their fixed
 * opening title) and package each one into a post kit.
 *
 *   npx tsx scripts/packaging/render.ts colorwar followball ringofdoom
 *   npx tsx scripts/packaging/render.ts --count 3 findthecat
 *   npx tsx scripts/packaging/render.ts --no-package eyetest     (just render)
 *
 * Formats: colorwar, ringofdoom, hotpotato, followball, eyetest, findthecat.
 */
import type { Broadcaster } from '../../worker/src/pipeline/context.ts';
import { COLORWARS_EVENT, renderColorwarsEvent, renderJsGame, type JsGame } from '../post/rotation.ts';
import { packageVideo, writeQueue } from './package.mjs';

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const count = Number(val('count') ?? 1);
const logPath = val('log');
const formats = args.filter((a, i) => !a.startsWith('--') && !['--count', '--log'].includes(args[i - 1] ?? ''));
const quiet: Broadcaster = (_j, _e, ev) => {
  if (ev.type === 'step:status' && ev.status !== 'running') console.error(`   [${ev.step}] ${ev.status}${ev.error ? ` — ${ev.error}` : ''}`);
};

async function main() {
let failed = 0;
for (const f of formats) {
  for (let i = 0; i < count; i++) {
    try {
      console.error(`\n### rendering ${f} (${i + 1}/${count})`);
      const dir = f === 'ringofdoom' || f === 'hotpotato'
        ? (await renderColorwarsEvent(COLORWARS_EVENT[f], () => {})).out_dir
        : (await renderJsGame(f as JsGame, quiet)).jobDir;
      console.error(`   rendered -> ${dir}`);
      if (!args.includes('--no-package')) await packageVideo(dir, { writeLog: logPath });
    } catch (err) {
      failed++;
      console.error(`   ✗ ${f}: ${(err as Error).message}`);
    }
  }
}
if (!args.includes('--no-package')) writeQueue(undefined, logPath ?? null);
process.exit(failed ? 1 : 0);
}

main();
