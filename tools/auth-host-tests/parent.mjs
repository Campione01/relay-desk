import { spawn } from 'node:child_process';

// Intentionally no exit/signal cleanup: abrupt death must be handled by native pipe/Job ownership.
const [helperPath, fakePath, directory, mode, windowedPath] = process.argv.slice(2);
const host = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
host.stdin.on('error', () => {});
host.stderr.resume();
let buffered = '';
host.stdout.setEncoding('utf8');
host.stdout.on('data', (chunk) => {
  buffered += chunk;
  for (;;) {
    const end = buffered.indexOf('\n');
    if (end < 0) break;
    const frame = JSON.parse(buffered.slice(0, end));
    buffered = buffered.slice(end + 1);
    process.send?.({ event: 'frame', frame });
  }
});
host.once('spawn', () => {
  const request = JSON.stringify({ protocol: 1, exe: fakePath, args: mode === 'family' ? ['family', directory, 'wait', windowedPath] : ['tree', directory, 'wait'], cwd: directory, env: process.env, title: 'Synthetic login only', visible: false, relayOutput: false, testPauseAfterCreate: mode === 'suspended' });
  if (mode === 'partial') host.stdin.write(request.slice(0, 40));
  else if (mode !== 'idle') host.stdin.write(`${request}\n`);
  process.send?.({ event: 'spawned', pid: host.pid });
});
host.once('close', (code) => { process.send?.({ event: 'closed', code }); process.exit(0); });
setTimeout(() => { host.kill(); process.exit(90); }, 15000).unref();
