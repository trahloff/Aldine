// Release smoke for the runner image (release.yml, smoke-runner). Runs in a
// container that shares only the runner's socket volume: asks for health
// (the container must pass its own security checks), then makes a PGF and a
// PDF figure with Matplotlib, the preview's whole purpose (docs/RUNNER.md).
import net from 'node:net';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const frames = createRequire(import.meta.url)('../apps/runner/frames.js');
const SOCKET = process.env.RUNNER_SOCKET || '/run/aldine-runner/runner.sock';

function exchange(head, files = []) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: SOCKET, allowHalfOpen: true });
    const reader = new frames.Reader({ maxFrame: 64 << 20, maxTotal: 128 << 20 });
    const got = [];
    sock.on('error', reject);
    sock.on('data', (c) => got.push(...reader.push(c)));
    sock.on('end', () => { sock.destroy(); if (reader.ended) resolve(got); else reject(new Error('the runner closed early')); });
    sock.on('connect', () => {
      sock.write(frames.header(head));
      for (const [p, c] of files) sock.write(frames.file(p, Buffer.from(c)));
      // Kept open until the answer, as the app does: hanging up asks the runner to stop.
      sock.write(frames.end());
    });
  });
}

const fail = (msg) => { console.error(`smoke-runner: FAIL: ${msg}`); process.exit(1); };
for (let i = 0; i < 60 && !fs.existsSync(SOCKET); i++) await new Promise((r) => setTimeout(r, 1000));

const health = (await exchange({ v: 2, health: true }))[0].value;
if (!health.ready) fail(`the runner is not ready: ${health.problem}`);
if (!/^[0-9a-f]{64}$/.test(health.runner.packages)) fail(`no package hash: ${health.runner.packages}`);
console.log(`runner ${health.runner.version}, packages ${health.runner.packages.slice(0, 12)}: ready`);

const plot = `import numpy as np, matplotlib
matplotlib.use("pgf")
import matplotlib.pyplot as plt
x = np.loadtxt("data.csv", delimiter=",")
plt.figure(figsize=(3, 2)); plt.plot(x[:, 0], x[:, 1], label=r"$y$"); plt.legend()
plt.savefig("fig/plot.pgf"); plt.savefig("fig/plot.pdf")
import urllib.request
try:
    urllib.request.urlopen("http://example.com", timeout=3); print("NETWORK REACHED")
except Exception:
    print("no network")
`;
const got = await exchange({ v: 2, command: 'mkdir -p fig && python plot.py', timeoutS: 120 }, [['plot.py', plot], ['data.csv', '0,1\n1,3\n2,2\n']]);
const head = got[0].value;
if (!head.ok) fail(head.error);
if (head.exitCode !== 0) fail(`exit ${head.exitCode}: ${head.log}`);
if (head.log.includes('NETWORK REACHED') || !head.log.includes('no network')) fail(`the job reached a network: ${head.log}`);
const back = Object.fromEntries(got.filter((f) => f.type === frames.FILE).map((f) => [f.path, f.content]));
if (!back['fig/plot.pdf']?.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('no PDF figure came back');
if (!back['fig/plot.pgf']?.toString('utf8').includes('Matplotlib')) fail('no PGF figure came back');
if (back['plot.py'] || back['data.csv']) fail('unchanged input files came back');
console.log(`smoke-runner: ok (${Object.keys(back).join(', ')} in ${(head.durationMs / 1000).toFixed(1)} s)`);
