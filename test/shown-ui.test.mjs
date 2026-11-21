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

function renderMutation(t, mutation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'visit.json');
  const out = path.join(dir, 'visit.md');
  const snapshots = [
    { type: 4, timestamp: mutation.timestamp - 1000, windowId: 'w1', data: { href: 'https://example.test/booking' } },
    { ...mutation, windowId: 'w1' },
  ];
  fs.writeFileSync(input, JSON.stringify({ data: { snapshots } }));
  execFileSync(process.execPath, [parser, input, out], { stdio: 'ignore' });
  return fs.readFileSync(out, 'utf8');
}

test('the recorded booking row follows nextId through right-to-left additions', t => {
  const fixture = new URL('./fixtures/booked-row-mutation.json', import.meta.url);
  const mutation = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const md = renderMutation(t, mutation);
  assert.match(md, /Mon, Nov 23 — 1:00 PM–1:50 PM/);
});

test('previousId positions flat additions among serialized children and missing links fall back to arrival order', t => {
  const text = (id, textContent) => ({ type: 3, id, textContent });
  const adds = [
    { parentId: 1, node: { type: 2, id: 10, tagName: 'button', childNodes: [text(11, 'A '), text(12, 'C ')] } },
    { parentId: 10, nextId: 22, node: text(13, 'D ') },
    { parentId: 10, previousId: 11, node: text(14, 'B ') },
    { parentId: 10, nextId: -1, node: text(15, 'E ') },
    { parentId: 10, previousId: 999, node: text(16, 'F') },
    { parentId: 20, node: { type: 2, id: 21, tagName: 'button', childNodes: [text(22, 'Other label')] } },
  ];
  const md = renderMutation(t, { type: 3, timestamp: 1790969241000, data: { source: 0, adds: packed(adds) } });
  assert.match(md, /A B C D E F/);
  assert.match(md, /Other label/);
});
