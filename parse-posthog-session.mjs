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

/**
 * PostHog emits every network request TWICE: once as the captured request
 * (carrying `method` and the request/response headers) and once as a bare
 * PerformanceResourceTiming replayed out of the browser's buffer, flagged
 * `isInitial: true` and carrying NO method. Both describe the same request —
 * identical `startTime`, `duration` and `responseStatus`, differing only in
 * `timeOrigin`/`timestamp`.
 *
 * Emitting both used to do two kinds of damage in the report:
 *  - the method-less copy fell through `r.method || 'GET'` and rendered a
 *    second, invented line with the WRONG VERB. A single failing
 *    `POST /api/.../preview` printed as both a POST 500 and a GET 500, and the
 *    twice-daily studio digest filed that phantom GET as a real broken
 *    endpoint (BECKY-1425, 2026-09-07 — the route exports no GET at all).
 *  - every request's `(xN)` occurrence count was doubled.
 *
 * So key each request on its identity and keep the FIRST copy seen, which is
 * the captured one that actually knows the verb.
 */
const seenNetworkEntries = new Set();

/**
 * One PostHog recording can contain snapshots from SEVERAL browser tabs —
 * every snapshot carries a top-level `windowId`, and PostHog merges all
 * windows of a session into one export. Treating the merged stream as a
 * single page sequence manufactures phantom navigations: a parked /login
 * tab's periodic checkpoints interleave with the active dashboard tab and
 * read as "dashboard -> /login -> dashboard", i.e. a mid-session sign-out
 * bounce that never happened (BECKY-1701, 2026-09-23 — the dashboard kept
 * issuing API calls throughout the "/login" segments because it was a
 * different tab). Every event is therefore tagged with its window and the
 * timeline is segmented per tab.
 */
const NO_WINDOW = 'default';

fileData.snapshots.forEach(s => {
  const ts = s.timestamp;
  if (!ts) return;
  const win = s.windowId || NO_WINDOW;

  // Page view / URL change (Type 4 Meta)
  if (s.type === 4 && s.data && s.data.href) {
    timeline.push({
      ts,
      type: 'NAV',
      url: s.data.href,
      win
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
        url,
        win
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
        // See seenNetworkEntries above: the same request arrives twice and only
        // one copy knows its method. The window is part of the identity — two
        // tabs issuing the same request are two real requests.
        const identity = `${win}|${name}|${r.startTime}|${r.duration}|${r.responseStatus}`;
        if (seenNetworkEntries.has(identity)) return;
        seenNetworkEntries.add(identity);

        timeline.push({
          ts,
          type: 'API',
          url: name,
          win,
          // Only default to GET when the entry is one the browser never had a
          // method for (navigations, scripts, iframes). Never invent a verb for
          // a fetch/XHR — a wrong verb reads as a different endpoint.
          method: r.method || (/^(fetch|xmlhttprequest)$/i.test(r.initiatorType || '') ? '(method not captured)' : 'GET'),
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
        text: s.data.text,
        win
      });
    }
  }
  
  // Clicks (Type 3 source 2 type 2)
  if (s.type === 3 && s.data && s.data.source === 2 && s.data.type === 2) {
    timeline.push({
      ts,
      type: 'CLICK',
      nodeId: s.data.id,
      win
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
          message: log.payload.join(' '),
          win
        });
      }
    });
  }
});

// Sort chronologically
timeline.sort((a, b) => a.ts - b.ts);

// Deduplicate consecutive navigation segments to same URL — PER WINDOW. A
// parked tab re-emits its current href on every ~5 min checkpoint; inside its
// own window those dedupe to one segment instead of looking like the user
// kept navigating back to it.
const dedupedNavs = [];
const lastNavUrlByWin = new Map();
timeline.forEach(e => {
  if (e.type === 'NAV') {
    const cleanUrl = e.url.split('?')[0]; // Compare without query parameters to prevent duplicates
    if (lastNavUrlByWin.get(e.win) !== cleanUrl) {
      dedupedNavs.push(e);
      lastNavUrlByWin.set(e.win, cleanUrl);
    }
  }
});

// Segment events by pageview, per window. A segment only absorbs events from
// its own tab — clicks and API calls in other tabs are parallel activity, not
// interactions on this page.
const navsByWin = new Map();
dedupedNavs.forEach(n => {
  if (!navsByWin.has(n.win)) navsByWin.set(n.win, []);
  navsByWin.get(n.win).push(n);
});

const segments = [];
navsByWin.forEach((navs, win) => {
  for (let i = 0; i < navs.length; i++) {
    const current = navs[i];
    const next = navs[i + 1];
    const startTime = current.ts;
    const endTime = next ? next.ts : Infinity;

    const segment = {
      url: current.url,
      startTime,
      endTime,
      win,
      clicks: 0,
      inputs: {},
      apiCalls: {},
      consoleErrors: []
    };

    timeline.forEach(e => {
      if (e.win === win && e.ts >= startTime && e.ts < endTime) {
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
});
segments.sort((a, b) => a.startTime - b.startTime);

// Label tabs by first activity so a multi-window recording reads as parallel
// pages, not one user teleporting between them.
const windowOrder = [];
segments.forEach(seg => {
  if (!windowOrder.includes(seg.win)) windowOrder.push(seg.win);
});
const windowLabel = new Map(windowOrder.map((w, i) => [w, `Tab ${i + 1}`]));
const multiWindow = windowOrder.length > 1;

// Generate Markdown report
let md = `# PostHog Session Onboarding Report
**User:** \`${email}\`  
**Organization ID:** \`${orgId}\`  
**Location:** ${location}  
**Environment:** ${device} (${browser} on ${os})  
**Analyzed Events:** ${fileData.snapshots.length} raw snapshots
${multiWindow ? `
> **This recording spans ${windowOrder.length} browser tabs.** Every row is one
> tab's page; rows in different tabs are PARALLEL pages open at the same time,
> not the user navigating. A tab that sits on one URL for the whole recording
> (e.g. a parked /login) appears as a single long segment — it is not a
> bounce back to that page.
` : ''}
---

## Onboarding Timeline Summary

| Time Spent | Page / URL Path |${multiWindow ? ' Tab |' : ''} Clicks | Inputs | API Calls |
| :--- | :--- |${multiWindow ? ' :--- |' : ''} :--- | :--- | :--- |
`;

segments.forEach(seg => {
  const durationSec = seg.endTime === Infinity ? 'End' : `${Math.round((seg.endTime - seg.startTime) / 1000)}s`;
  const urlPath = seg.url.replace(/^https?:\/\/[^\/]+/i, '');
  const apiCount = Object.values(seg.apiCalls).reduce((sum, count) => sum + count, 0);
  const inputCount = Object.keys(seg.inputs).length;

  md += `| **${durationSec}** | \`${urlPath || '/'}\` |${multiWindow ? ` ${windowLabel.get(seg.win)} |` : ''} ${seg.clicks} | ${inputCount} | ${apiCount} |\n`;
});

md += `\n---\n\n## Detailed Interaction Flow\n`;

segments.forEach(seg => {
  const durationSec = seg.endTime === Infinity ? 'End' : `${Math.round((seg.endTime - seg.startTime) / 1000)}s`;
  const timeString = new Date(seg.startTime).toISOString();

  md += `\n### 🌐 Page: \`${seg.url}\`${multiWindow ? ` (${windowLabel.get(seg.win)})` : ''}  \n`;
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
