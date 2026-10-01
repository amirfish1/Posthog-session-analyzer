import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const parser = fileURLToPath(new URL('../parse-posthog-session.mjs', import.meta.url));

// BECKY-1892: a long-open Mobile Safari tab's performance buffer carried a
// swap-instructors 400 from three days earlier into a new recording; the
// digest placed it at the recording's start time.
test('isInitial entries older than the recording are labelled pre-recording', () => {
  const win = 'w1';
  const start = Date.parse('2026-09-30T13:01:10Z');
  const oldOrigin = Date.parse('2026-09-27T04:17:48Z');
  const req = (over) => ({ initiatorType: 'fetch', isInitial: true, duration: 280, responseEnd: 1, ...over });
  const snapshots = [
    { type: 4, timestamp: start, windowId: win, data: { href: 'https://bookyourmat.com/dashboard' } },
    { type: 6, timestamp: start + 500, windowId: win, data: { plugin: 'rrweb/network@1', payload: { requests: [
      req({ name: 'https://bookyourmat.com/api/v1/pilates/appointments/swap-instructors', responseStatus: 400, timeOrigin: oldOrigin, startTime: 58598 }),
      req({ name: 'https://bookyourmat.com/api/v1/app-version', responseStatus: 200, timeOrigin: start - 2000, startTime: 1500 }),
    ] } } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-buf-'));
  const input = path.join(dir, 's.json');
  const out = path.join(dir, 's.md');
  fs.writeFileSync(input, JSON.stringify({ data: { snapshots } }));
  execFileSync(process.execPath, [parser, input, out], { stdio: 'ignore' });
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /swap-instructors \(Status: 400\) \[BEFORE THIS RECORDING — .*2026-09-27T04:18:46\.598Z or earlier/);
  // A buffered entry from just before the recorder started is not flagged.
  assert.match(md, /app-version \(Status: 200\)(?! \[BEFORE)/);
});
