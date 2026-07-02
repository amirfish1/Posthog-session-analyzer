#!/usr/bin/env node

/**
 * parse-posthog-session.mjs
 * 
 * A utility script to parse a raw PostHog Session Recording Player export file (.json)
 * and generate a high-level, human-readable timeline report (Markdown).
 * 
 * Usage:
 *   node scripts/parse-posthog-session.mjs <input_path.json> [output_path.md]
 */

import fs from 'fs';
import path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
Usage:
  node scripts/parse-posthog-session.mjs <input_path.json> [output_path.md]

Options:
  <input_path.json>   Path to the exported PostHog session recording JSON.
  [output_path.md]    (Optional) Path to save the Markdown report. Defaults to input path with .timeline.md extension.
`);
  process.exit(0);
}

const inputPath = path.resolve(args[0]);
const outputPath = args[1] 
  ? path.resolve(args[1]) 
  : inputPath.replace(/\.json$/i, '') + '.timeline.md';

if (!fs.existsSync(inputPath)) {
  console.error(`Error: File not found at "${inputPath}"`);
  process.exit(1);
}

console.log(`Reading "${inputPath}"...`);
let rawData;
try {
  rawData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  console.error(`Error parsing JSON file: ${e.message}`);
  process.exit(1);
}

const fileData = rawData.data || rawData;
if (!fileData || !fileData.snapshots) {
  console.error('Error: Invalid format. Could not find "snapshots" array inside JSON.');
  process.exit(1);
}

const person = fileData.person || {};
const personProperties = person.properties || {};
const email = personProperties.email || person.name || 'Anonymous User';
const orgId = personProperties.organization_id || 'N/A';
const browser = personProperties.$browser || 'Unknown';
const os = personProperties.$os || 'Unknown';
const device = personProperties.$device_type || 'Unknown';
const location = `${personProperties.$geoip_city_name || 'Unknown'}, ${personProperties.$geoip_subdivision_1_name || ''} (${personProperties.$geoip_country_code || ''})`.replace(/, \(\)/, '');

console.log(`Processing ${fileData.snapshots.length} player events...`);

const timeline = [];

fileData.snapshots.forEach(s => {
  const ts = s.timestamp;
  if (!ts) return;
  
  // Page view / URL change (Type 4 Meta)
  if (s.type === 4 && s.data && s.data.href) {
    timeline.push({
      ts,
      type: 'NAV',
      url: s.data.href
    });
  }
  
  // URL Changed (Type 5 Custom tag: $url_changed)
  if (s.type === 5 && s.data && (s.data.tag === '$url_changed' || s.data.tag === '$pageview')) {
    let url = '';
    if (typeof s.data.payload === 'string') {
      url = s.data.payload;
    } else if (s.data.payload && s.data.payload.current_url) {
      url = s.data.payload.current_url;
    } else if (s.data.href) {
      url = s.data.href;
    }
    if (url) {
      timeline.push({
        ts,
        type: 'NAV',
        url
      });
    }
  }
  
  // Network Request (Type 6 rrweb/network@1)
  if (s.type === 6 && s.data && s.data.plugin === 'rrweb/network@1' && s.data.payload && s.data.payload.requests) {
    s.data.payload.requests.forEach(r => {
      const name = r.name || '';
      if (!name) return;
      
      // Filter out static resources and external trackers
      const isStatic = /\.(png|jpg|jpeg|gif|svg|woff2|woff|ttf|css|js)/i.test(name) || name.includes('/_next/') || name.includes('/static/');
      const isTracker = name.includes('posthog') || name.includes('google-analytics') || name.includes('facebook.com') || name.includes('hotjar') || name.includes('doubleclick') || name.includes('google.com/pagead');
      
      if (!isStatic && !isTracker) {
        timeline.push({
          ts,
          type: 'API',
          url: name,
          method: r.method || 'GET',
          status: r.responseStatus
        });
      }
    });
  }
  
  // Inputs (Type 3 source 5)
  if (s.type === 3 && s.data && s.data.source === 5) {
    if (s.data.text && s.data.text.trim().length > 0) {
      timeline.push({
        ts,
        type: 'INPUT',
        nodeId: s.data.id,
        text: s.data.text
      });
    }
  }
  
  // Clicks (Type 3 source 2 type 2)
  if (s.type === 3 && s.data && s.data.source === 2 && s.data.type === 2) {
    timeline.push({
      ts,
      type: 'CLICK',
      nodeId: s.data.id
    });
  }

  // Console Logs/Errors (Type 6 rrweb/console@1)
  if (s.type === 6 && s.data && s.data.plugin === 'rrweb/console@1' && s.data.payload && s.data.payload.logs) {
    s.data.payload.logs.forEach(log => {
      if (log.level === 'error' || log.level === 'warn') {
        timeline.push({
          ts,
          type: 'CONSOLE',
          level: log.level,
          message: log.payload.join(' ')
        });
      }
    });
  }
});

// Sort chronologically
timeline.sort((a, b) => a.ts - b.ts);

// Deduplicate consecutive navigation segments to same URL
const dedupedNavs = [];
let lastNavUrl = '';
timeline.forEach(e => {
  if (e.type === 'NAV') {
    const cleanUrl = e.url.split('?')[0]; // Compare without query parameters to prevent duplicates
    if (cleanUrl !== lastNavUrl) {
      dedupedNavs.push(e);
      lastNavUrl = cleanUrl;
    }
  }
});

// Segment events by pageview
const segments = [];
for (let i = 0; i < dedupedNavs.length; i++) {
  const current = dedupedNavs[i];
  const next = dedupedNavs[i + 1];
  const startTime = current.ts;
  const endTime = next ? next.ts : Infinity;
  
  const segment = {
    url: current.url,
    startTime,
    endTime,
    clicks: 0,
    inputs: {},
    apiCalls: {},
    consoleErrors: []
  };
  
  timeline.forEach(e => {
    if (e.ts >= startTime && e.ts < endTime) {
      if (e.type === 'CLICK') {
        segment.clicks++;
      } else if (e.type === 'INPUT') {
        segment.inputs[e.nodeId] = e.text;
      } else if (e.type === 'API') {
        const key = `${e.method} ${e.url.split('?')[0]} (Status: ${e.status || 'N/A'})`;
        segment.apiCalls[key] = (segment.apiCalls[key] || 0) + 1;
      } else if (e.type === 'CONSOLE') {
        segment.consoleErrors.push(`[${e.level.toUpperCase()}] ${e.message}`);
      }
    }
  });
  
  segments.push(segment);
}

// Generate Markdown report
let md = `# PostHog Session Onboarding Report
**User:** \`${email}\`  
**Organization ID:** \`${orgId}\`  
**Location:** ${location}  
**Environment:** ${device} (${browser} on ${os})  
**Analyzed Events:** ${fileData.snapshots.length} raw snapshots

---

## Onboarding Timeline Summary

| Time Spent | Page / URL Path | Clicks | Inputs | API Calls |
| :--- | :--- | :--- | :--- | :--- |
`;

segments.forEach(seg => {
  const durationSec = seg.endTime === Infinity ? 'End' : `${Math.round((seg.endTime - seg.startTime) / 1000)}s`;
  const urlPath = seg.url.replace(/^https?:\/\/[^\/]+/i, '');
  const apiCount = Object.values(seg.apiCalls).reduce((sum, count) => sum + count, 0);
  const inputCount = Object.keys(seg.inputs).length;
  
  md += `| **${durationSec}** | \`${urlPath || '/'}\` | ${seg.clicks} | ${inputCount} | ${apiCount} |\n`;
});

md += `\n---\n\n## Detailed Interaction Flow\n`;

segments.forEach(seg => {
  const durationSec = seg.endTime === Infinity ? 'End' : `${Math.round((seg.endTime - seg.startTime) / 1000)}s`;
  const timeString = new Date(seg.startTime).toISOString();
  
  md += `\n### 🌐 Page: \`${seg.url}\`  \n`;
  md += `* **Time:** \`${timeString}\` (Duration: **${durationSec}**)\n`;
  md += `* **Clicks:** ${seg.clicks} interactions  \n`;
  
  // Log non-empty inputs
  const inputKeys = Object.keys(seg.inputs);
  if (inputKeys.length > 0) {
    md += `* **Form Inputs Filled:**\n`;
    inputKeys.forEach(id => {
      const val = seg.inputs[id];
      const displayVal = val.length > 500 ? val.substring(0, 500) + '...' : val;
      md += `  * Node #${id}: \`${displayVal}\`\n`;
    });
  }
  
  // Log unique API calls
  const apiKeys = Object.keys(seg.apiCalls);
  if (apiKeys.length > 0) {
    md += `* **Key API Calls:**\n`;
    apiKeys.forEach(key => {
      md += `  * \`${key}\` (x${seg.apiCalls[key]})\n`;
    });
  }
  
  // Log Console errors/warnings
  if (seg.consoleErrors.length > 0) {
    md += `* **⚠️ Console Logs/Errors:**\n`;
    const uniqueErrors = Array.from(new Set(seg.consoleErrors)).slice(0, 10);
    uniqueErrors.forEach(err => {
      md += `  * \`${err}\`\n`;
    });
    if (seg.consoleErrors.length > 10) {
      md += `  * *...and ${seg.consoleErrors.length - 10} more console events*\n`;
    }
  }
});

fs.writeFileSync(outputPath, md);
console.log(`\nTimeline Markdown report successfully generated at:`);
console.log(`👉 "${outputPath}"`);
