#!/usr/bin/env node

/**
 * download-posthog-session.mjs
 * 
 * Downloads a PostHog Session Recording directly from the PostHog API
 * using the key from .env.local, decompresses the snapshot data, merges them,
 * and automatically calls parse-posthog-session.mjs to generate a Markdown timeline.
 * 
 * Usage:
 *   node scripts/download-posthog-session.mjs <session_id> [output_dir]
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Usage:
  node scripts/download-posthog-session.mjs <session_id> [output_dir]

Options:
  <session_id>    The PostHog Session Recording UUID (e.g. 019f1f46-f22b-78b4-a9f5-3a505182331c)
  [output_dir]    (Optional) Directory where JSON and MD report should be saved. Defaults to current directory.
`);
  process.exit(0);
}

const sessionId = args[0];
const outputDir = args[1] ? path.resolve(args[1]) : process.cwd();

// Load POSTHOG_PERSONAL_API_KEY from .env.local
const envPath = path.resolve(__dirname, './.env.local');
if (!fs.existsSync(envPath)) {
  console.error(`Error: .env.local file not found at "${envPath}"`);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const apiKeyMatch = envContent.match(/POSTHOG_PERSONAL_API_KEY\s*=\s*(phx_[a-zA-Z0-9]+)/);
if (!apiKeyMatch) {
  console.error('Error: POSTHOG_PERSONAL_API_KEY not found in .env.local');
  process.exit(1);
}
const apiKey = apiKeyMatch[1];
const projectId = 334176; // Scoped project ID for BookYourMat
const host = 'https://us.posthog.com';

const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PostHog throttles this endpoint; DRF's 429 response carries a `Retry-After`
// header in seconds (and repeats the number in the body, e.g. "Request was
// throttled. Expected available in 15 seconds."). Batches were previously
// fired back-to-back regardless of that hint, so once a session hit one 429
// every remaining batch in the same run failed too — 9 of 12 sessions in one
// digest came back as "(download/parse failed: ... 429 ...)" with no
// timeline. Honor the hint (falling back to a fixed delay if it's absent)
// and retry before giving up.
async function retryAfterSeconds(res, bodyText) {
  const header = res.headers.get('retry-after');
  if (header && !Number.isNaN(Number(header))) return Number(header);
  const match = bodyText.match(/available in (\d+(?:\.\d+)?) seconds?/i);
  if (match) return Number(match[1]);
  return 15;
}

async function fetchWithRetry(url, parse) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (res.status === 429) {
      const bodyText = await res.text();
      const waitSec = await retryAfterSeconds(res, bodyText);
      if (attempt === MAX_RETRIES) {
        throw new Error(`API returned HTTP 429 after ${MAX_RETRIES} attempts: ${bodyText}`);
      }
      console.warn(`  Throttled (429) — waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`API returned HTTP ${res.status}: ${await res.text()}`);
    }
    return parse(res);
  }
}

async function requestJson(url) {
  return fetchWithRetry(url, (res) => res.json());
}

async function requestText(url) {
  return fetchWithRetry(url, (res) => res.text());
}

async function main() {
  try {
    console.log(`--- Fetching Metadata for Session ${sessionId} ---`);
    const metaUrl = `${host}/api/projects/${projectId}/session_recordings/${sessionId}`;
    const meta = await requestJson(metaUrl);
    console.log(`Recording User: ${meta.person?.properties?.email || meta.person?.name || 'Anonymous'}`);
    console.log(`Duration: ${meta.duration}s`);
    
    console.log(`\n--- Fetching Snapshot Blobs List ---`);
    const sourcesUrl = `${metaUrl}/snapshots`;
    const sourcesData = await requestJson(sourcesUrl);
    const blobs = sourcesData.sources || [];
    console.log(`Found ${blobs.length} blobs in this session.`);
    if (blobs.length === 0) {
      console.error('Error: No snapshot blobs found for this session.');
      return;
    }
    
    const blobKeys = blobs.map(b => b.blob_key);
    console.log('Blob keys to fetch:', blobKeys.join(', '));
    
    // PostHog limits requests to 20 blob keys at a time. Fetch in batches.
    const batchSize = 15;
    let allSnapshots = [];
    
    for (let i = 0; i < blobKeys.length; i += batchSize) {
      const batch = blobKeys.slice(i, i + batchSize);
      const startKey = batch[0];
      const endKey = batch[batch.length - 1];
      const batchUrl = `${metaUrl}/snapshots?source=blob_v2&start_blob_key=${startKey}&end_blob_key=${endKey}`;
      
      console.log(`Fetching batch ${Math.floor(i / batchSize) + 1}... (blobs ${startKey} to ${endKey})`);
      const rawText = await requestText(batchUrl);
      
      // PostHog snapshot API returns JSON Lines (JSONL) where each line is: [windowId, eventObject]
      const lines = rawText.split('\n').filter(line => line.trim().length > 0);
      console.log(`  Received ${lines.length} lines.`);
      
      lines.forEach((line, index) => {
        try {
          const parsed = JSON.parse(line);
          if (!Array.isArray(parsed) || parsed.length < 2) return;
          
          const windowId = parsed[0];
          const eventObject = parsed[1];
          eventObject.windowId = windowId;
          
          // Decompress data if it is GZIP compressed
          if (eventObject.data && typeof eventObject.data === 'string') {
            const buffer = Buffer.from(eventObject.data, 'binary');
            if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
              const decompressed = zlib.gunzipSync(buffer);
              eventObject.data = JSON.parse(decompressed.toString('utf8'));
            }
          }
          
          allSnapshots.push(eventObject);
        } catch (err) {
          console.warn(`  Warning: Failed to parse line ${index + 1} in batch: ${err.message}`);
        }
      });
    }
    
    console.log(`\nTotal events decompressed & merged: ${allSnapshots.length}`);
    
    // Construct standard JSON export format
    const outputJSON = {
      version: '2023-04-28',
      data: {
        id: sessionId,
        person: {
          id: meta.person?.id || 0,
          name: meta.person?.name || '',
          distinct_ids: meta.distinct_id ? [meta.distinct_id] : [],
          properties: meta.person?.properties || {}
        },
        snapshots: allSnapshots
      }
    };
    
    // Save JSON file
    const jsonPath = path.join(outputDir, `posthog-session-${sessionId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(outputJSON, null, 2));
    console.log(`Saved raw session recording JSON to:\n👉 "${jsonPath}"`);
    
    // Automatically run the parsing script
    console.log('\n--- Generating Markdown Timeline Report ---');
    const parserPath = path.join(__dirname, 'parse-posthog-session.mjs');
    const mdPath = path.join(outputDir, `posthog-session-${sessionId}.timeline.md`);
    
    execSync(`node "${parserPath}" "${jsonPath}" "${mdPath}"`, { stdio: 'inherit' });
    
  } catch (error) {
    console.error('\n❌ Execution failed:', error.message);
    process.exit(1);
  }
}

main();
