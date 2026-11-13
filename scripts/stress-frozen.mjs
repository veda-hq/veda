// Runs dvara's frozen.test.ts many times at once, beside busy-loop workers,
// and counts the runs that fail with ENOENT. STRESS-ONLY, never merged (#50).
// Usage (from packages/dvara):
//   node ../../scripts/stress-frozen.mjs [runs] [parallel] [burners]
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';

const runs = Number(process.argv[2] ?? 60);
const parallel = Number(process.argv[3] ?? cpus().length);
const burners = Number(process.argv[4] ?? cpus().length);

const workers = [];
for (let i = 0; i < burners; i++) {
  workers.push(new Worker('for (;;) Math.sqrt(Math.random());', { eval: true }));
}

let started = 0;
let failed = 0;
let enoent = 0;
const samples = [];
function one() {
  if (started >= runs) return Promise.resolve();
  started++;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', 'src/records/frozen.test.ts'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('close', code => {
      if (code !== 0) {
        failed++;
        if (/ENOENT/.test(out)) {
          enoent++;
        }
        if (samples.length < 3) samples.push(out.slice(out.indexOf('failing tests'), out.indexOf('failing tests') + 6000));
      }
      resolve(one());
    });
  });
}
await Promise.all(Array.from({ length: parallel }, one));
for (const w of workers) w.terminate();
console.log(`runs ${runs}, parallel ${parallel}, burners ${burners}: failed ${failed}, ENOENT ${enoent}`);
for (const s of samples) console.log(`---\n${s}`);
process.exit(failed > 0 ? 1 : 0);
