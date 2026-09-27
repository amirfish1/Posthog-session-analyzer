import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const parser = fileURLToPath(new URL('../parse-posthog-session.mjs', import.meta.url));

// BECKY-1826: PostHog records a clicked card as two source-5 events — a JSON
// blob with the real innerText (behind a long classList/imageUrl) and a flat
// copy with every digit run masked to "0". The timeline showed only the masked
// copy, so the digest reported class cards rendering "0 min · $0".
test('clicked-element blob surfaces real innerText and drops the digit-masked twin', () => {
  const win = 'w1';
  const ts = 1790450417422;
  const blob = JSON.stringify({
    classList: 'x'.repeat(300),
    imageUrl: '/_next/image?url=' + 'y'.repeat(300),
    innerText: 'MOVE - Pilates All Levels\nGroup\n50 min\n$80/session\nBook',
    tag: 'button',
  });
  const snapshots = [
    { type: 4, timestamp: ts - 1000, windowId: win, data: { href: 'https://bookyourmat.com/book/x' } },
    { type: 3, timestamp: ts, windowId: win, data: { source: 5, id: 433, text: blob } },
    { type: 3, timestamp: ts, windowId: win, data: { source: 5, id: 432, text: 'MOVE - Pilates All LevelsGroup0 min$0/sessionBook' } },
    { type: 3, timestamp: ts + 10, windowId: win, data: { source: 5, id: 9, text: 'call me at 555 1234' } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-twin-'));
  const input = path.join(dir, 's.json');
  const out = path.join(dir, 's.md');
  fs.writeFileSync(input, JSON.stringify({ data: { snapshots } }));
  execFileSync(process.execPath, [parser, input, out], { stdio: 'ignore' });
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /<button> MOVE - Pilates All Levels \/ Group \/ 50 min \/ \$80\/session \/ Book/);
  assert.doesNotMatch(md, /0 min\$0/);
  // Ordinary typed input with digits is untouched.
  assert.match(md, /call me at 555 1234/);
});
