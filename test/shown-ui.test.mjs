import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const parser = fileURLToPath(new URL('../parse-posthog-session.mjs', import.meta.url));

// PostHog ships rrweb mutation `adds` as a gzip blob in a latin-1 string.
const packed = (v) => zlib.gzipSync(Buffer.from(JSON.stringify(v), 'utf8')).toString('latin1');

// BECKY-1948: a checkout waiver step rendered inside a modal, but the timeline
// never unpacked mutations, so the digest reported "the waiver won't come up".
test('UI rendered after load (compressed, flattened adds) is listed per segment', () => {
  const win = 'w1';
  const ts = 1790969241000;
  const adds = [
    { parentId: 10, node: { type: 2, id: 20, tagName: 'h4', attributes: {}, childNodes: [] } },
    { parentId: 20, node: { type: 3, id: 21, textContent: 'Sign the waiver to continue' } },
    { parentId: 10, node: { type: 2, id: 22, tagName: 'input', attributes: { type: 'text', placeholder: 'Full Legal Name' }, childNodes: [] } },
    { parentId: 10, node: { type: 2, id: 23, tagName: 'button', attributes: {}, childNodes: [{ type: 3, id: 24, textContent: 'Sign and continue' }] } },
    { parentId: 10, node: { type: 2, id: 25, tagName: 'div', attributes: {}, childNodes: [{ type: 3, id: 26, textContent: 'Body copy is not a label' }] } },
  ];
  const snapshots = [
    { type: 4, timestamp: ts - 5000, windowId: win, data: { href: 'https://bookyourmat.com/portal/x/dashboard' } },
    { type: 3, timestamp: ts, windowId: win, data: { source: 0, adds: packed(adds), texts: packed([]), attributes: packed([]), removes: packed([]) } },
    // A later re-render of the same labels is not repeated.
    { type: 3, timestamp: ts + 2000, windowId: win, data: { source: 0, adds: packed(adds.slice(0, 2)) } },
    // Uncompressed (plain array) adds still work, and garbage never throws.
    { type: 3, timestamp: ts + 3000, windowId: win, data: { source: 0, adds: [{ parentId: 1, node: { type: 2, id: 30, tagName: 'button', attributes: {}, childNodes: [{ type: 3, id: 31, textContent: 'Close' }] } }] } },
    { type: 3, timestamp: ts + 4000, windowId: win, data: { source: 0, adds: 'not gzip' } },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-shown-'));
  const input = path.join(dir, 's.json');
  const out = path.join(dir, 's.md');
  fs.writeFileSync(input, JSON.stringify({ data: { snapshots } }));
  execFileSync(process.execPath, [parser, input, out], { stdio: 'ignore' });
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /UI that appeared after load/);
  assert.match(md, /Sign the waiver to continue/);
  assert.match(md, /\[field: Full Legal Name\]/);
  assert.match(md, /Sign and continue/);
  assert.match(md, /Close/);
  assert.doesNotMatch(md, /Body copy is not a label/);
  assert.equal(md.match(/Sign the waiver to continue/g).length, 1);
});
