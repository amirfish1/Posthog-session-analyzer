#!/usr/bin/env node

/**
 * session-analyzer-dashboard.mjs
 * 
 * A standalone zero-dependency developer dashboard to list recent PostHog sessions,
 * search/filter them, and analyze them in one click.
 * 
 * Run:
 *   node scripts/session-analyzer-dashboard.mjs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3099;

// Load credentials
const envPath = path.resolve(__dirname, './.env.local');
if (!fs.existsSync(envPath)) {
  console.error(`Error: .env.local file not found at "${envPath}"`);
  process.exit(1);
}
const envContent = fs.readFileSync(envPath, 'utf8');

// Get PostHog key
const apiKeyMatch = envContent.match(/POSTHOG_PERSONAL_API_KEY\s*=\s*(phx_[a-zA-Z0-9]+)/);
if (!apiKeyMatch) {
  console.error('Error: POSTHOG_PERSONAL_API_KEY not found in .env.local');
  process.exit(1);
}
const apiKey = apiKeyMatch[1];
const projectId = 334176;
const host = 'https://us.posthog.com';

// Get OpenAI key if available
const openaiKeyMatch = envContent.match(/OPENAI_API_KEY\s*=\s*([^\s#]+)/);
const openaiApiKey = openaiKeyMatch ? openaiKeyMatch[1] : null;

if (openaiApiKey) {
  console.log('OpenAI API Key detected. Onboarding reports will be synthesized using LLM analysis.');
} else {
  console.log('No OpenAI API Key detected. Reports will show the raw parsed event timeline.');
}

async function requestJson(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    throw new Error(`API returned HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function requestText(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    throw new Error(`API returned HTTP ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

// Download and decompress snapshots
async function downloadSessionData(sessionId) {
  const metaUrl = `${host}/api/projects/${projectId}/session_recordings/${sessionId}`;
  const meta = await requestJson(metaUrl);
  
  const sourcesUrl = `${metaUrl}/snapshots`;
  const sourcesData = await requestJson(sourcesUrl);
  const blobs = sourcesData.sources || [];
  if (blobs.length === 0) {
    throw new Error('No snapshot blobs found for this session.');
  }
  
  const blobKeys = blobs.map(b => b.blob_key);
  const batchSize = 15;
  let allSnapshots = [];
  
  for (let i = 0; i < blobKeys.length; i += batchSize) {
    const batch = blobKeys.slice(i, i + batchSize);
    const startKey = batch[0];
    const endKey = batch[batch.length - 1];
    const batchUrl = `${metaUrl}/snapshots?source=blob_v2&start_blob_key=${startKey}&end_blob_key=${endKey}`;
    
    const rawText = await requestText(batchUrl);
    const lines = rawText.split('\n').filter(line => line.trim().length > 0);
    
    lines.forEach(line => {
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          const windowId = parsed[0];
          const eventObject = parsed[1];
          eventObject.windowId = windowId;
          
          if (eventObject.data && typeof eventObject.data === 'string') {
            const buffer = Buffer.from(eventObject.data, 'binary');
            if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
              const decompressed = zlib.gunzipSync(buffer);
              eventObject.data = JSON.parse(decompressed.toString('utf8'));
            }
          }
          allSnapshots.push(eventObject);
        }
      } catch (e) {
        // Line parse warning
      }
    });
  }
  
  return {
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
    },
    meta
  };
}

// Calls OpenAI to synthesize the report
async function synthesizeReport(rawMarkdown, userEmail) {
  if (!openaiApiKey) {
    return rawMarkdown;
  }
  
  console.log(`[Dashboard] Querying OpenAI (gpt-4o-mini) to synthesize timeline report for ${userEmail}...`);
  const url = 'https://api.openai.com/v1/chat/completions';
  
  const prompt = `You are a Senior Product Analyst and UX Researcher for BookYourMat, a Pilates studio scheduling & payment platform.
Your task is to analyze the following raw user session timeline log and write a beautiful, highly structured UX Analysis Report in Markdown.

The report should look clean, professional, and be extremely readable, focusing on key actions, friction points, configurations, and clear recommendations.

Raw Session Timeline Log:
${rawMarkdown}

Please output the UX Analysis Report in Markdown. Use styled alert quotes if needed. Start directly with '# Onboarding Analysis...'. Do not wrap the output in raw markdown block ticks.`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a senior product analyst specializing in UX research and user onboarding conversion.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    })
  });
  
  if (!res.ok) {
    const errText = await res.text();
    console.error('[Dashboard] OpenAI API failed:', errText);
    return rawMarkdown + `\n\n*(Note: LLM synthesis failed: ${errText})*`;
  }
  
  const data = await res.json();
  return data.choices[0].message.content;
}

// Start HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // API: Get recent sessions
  if (url.pathname === '/api/sessions') {
    try {
      const phUrl = `${host}/api/projects/${projectId}/session_recordings/?limit=200&date_from=-10d`;
      const data = await requestJson(phUrl);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.results || []));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // API: Analyze specific session
  if (url.pathname === '/api/analyze') {
    const sessionId = url.searchParams.get('id');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return;
    }
    
    try {
      console.log(`[Dashboard] Downloading session ${sessionId}...`);
      const sessionData = await downloadSessionData(sessionId);
      const meta = sessionData.meta;
      const userEmail = meta.person?.properties?.email || meta.person?.name || sessionId;
      
      // Save raw JSON locally
      const tempJsonPath = path.join(__dirname, `./tmp-session-${sessionId}.json`);
      fs.writeFileSync(tempJsonPath, JSON.stringify(sessionData, null, 2));
      
      // Run the parser
      const tempMdPath = path.join(__dirname, `./tmp-session-${sessionId}.md`);
      const parserPath = path.join(__dirname, 'parse-posthog-session.mjs');
      
      execSync(`node "${parserPath}" "${tempJsonPath}" "${tempMdPath}"`);
      
      const mdContent = fs.readFileSync(tempMdPath, 'utf8');
      
      // Clean up temporary files
      try {
        fs.unlinkSync(tempJsonPath);
        fs.unlinkSync(tempMdPath);
      } catch (err) {
        // Silent clean up errors
      }
      
      // Synthesize raw timeline using OpenAI
      const reportMarkdown = await synthesizeReport(mdContent, userEmail);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ markdown: reportMarkdown }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // Static HTML App
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BookYourMat — Onboarding Session Diagnostics</title>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=Outfit:wght@400;600;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
  <!-- Markdown parser library -->
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg-dark: #0a0e17;
      --bg-surface: rgba(18, 26, 42, 0.65);
      --bg-surface-hover: rgba(26, 38, 62, 0.85);
      --bym-punch: #fe6e00;
      --bym-punch-hover: #e06100;
      --bym-charcoal: #cad5e2;
      --border-color: rgba(255, 255, 255, 0.08);
      --text-primary: #ffffff;
      --text-secondary: #90a1b9;
      --text-accent: #ff8b1a;
      --radius-lg: 16px;
      --radius-md: 8px;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg-dark);
      color: var(--text-primary);
      font-family: 'Manrope', sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(254, 110, 0, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(30, 128, 255, 0.05) 0%, transparent 40%);
    }
    header {
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-color);
      padding: 1.25rem 2rem;
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-logo {
      font-family: 'Outfit', sans-serif;
      font-weight: 800;
      font-size: 1.5rem;
      background: linear-gradient(135deg, #ffffff 0%, var(--bym-punch) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .badge {
      background: rgba(254, 110, 0, 0.15);
      color: var(--text-accent);
      border: 1px solid rgba(254, 110, 0, 0.3);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .container {
      max-width: 1400px;
      margin: 2rem auto;
      padding: 0 1.5rem;
      display: grid;
      grid-template-columns: 1fr;
      gap: 2rem;
    }
    @media (min-width: 1100px) {
      .container {
        grid-template-columns: 1.1fr 0.9fr;
      }
    }
    .panel {
      background: var(--bg-surface);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      height: calc(100vh - 180px);
      min-height: 500px;
    }
    .panel-header {
      margin-bottom: 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    .panel-title {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      font-size: 1.2rem;
    }
    .search-input {
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 0.6rem 1rem;
      border-radius: var(--radius-md);
      font-family: inherit;
      width: 100%;
      max-width: 300px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus {
      border-color: var(--bym-punch);
    }
    .table-container {
      overflow-y: auto;
      flex: 1;
      border-radius: var(--radius-md);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    th {
      background: rgba(0, 0, 0, 0.3);
      color: var(--text-secondary);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .btn-analyze {
      background: var(--bym-punch);
      color: var(--text-primary);
      border: none;
      padding: 0.4rem 0.8rem;
      font-family: inherit;
      font-weight: 700;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background-color 0.2s, opacity 0.2s;
    }
    .btn-analyze:hover {
      background: var(--bym-punch-hover);
    }
    .btn-analyze:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .loading-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: rgba(10, 14, 23, 0.85);
      z-index: 200;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 1.5rem;
      border-radius: var(--radius-lg);
    }
    .spinner {
      width: 50px;
      height: 50px;
      border: 4px solid rgba(254, 110, 0, 0.1);
      border-top-color: var(--bym-punch);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .report-panel {
      position: relative;
    }
    
    /* Styled Markdown Content styling */
    .report-content {
      background: rgba(0, 0, 0, 0.25);
      border-radius: var(--radius-md);
      padding: 1.5rem;
      flex: 1;
      overflow-y: auto;
      color: var(--bym-charcoal);
      border: 1px solid rgba(255, 255, 255, 0.04);
      line-height: 1.6;
    }
    .report-content h1, .report-content h2, .report-content h3 {
      font-family: 'Outfit', sans-serif;
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      color: var(--text-primary);
    }
    .report-content h1 {
      font-size: 1.5rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.5rem;
    }
    .report-content h2 {
      font-size: 1.25rem;
      color: var(--text-accent);
    }
    .report-content h3 {
      font-size: 1.1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      padding-bottom: 0.25rem;
    }
    .report-content p {
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .report-content ul, .report-content ol {
      margin-bottom: 1rem;
      padding-left: 1.5rem;
    }
    .report-content li {
      margin-bottom: 0.4rem;
      font-size: 0.9rem;
    }
    .report-content code {
      font-family: 'Fira Code', monospace;
      background: rgba(255, 255, 255, 0.06);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
      color: #ff8b1a;
    }
    .report-content pre {
      background: rgba(0, 0, 0, 0.4);
      padding: 1rem;
      border-radius: var(--radius-md);
      overflow-x: auto;
      margin-bottom: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.04);
    }
    .report-content pre code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: 0.825rem;
    }
    .report-content table {
      margin: 1rem 0;
      width: 100%;
      border-collapse: collapse;
    }
    .report-content th, .report-content td {
      padding: 0.6rem 0.8rem;
      border: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 0.85rem;
    }
    .report-content th {
      background: rgba(254, 110, 0, 0.1);
      color: var(--text-primary);
      font-weight: 600;
    }
    .report-content hr {
      border: 0;
      border-top: 1px solid var(--border-color);
      margin: 1.5rem 0;
    }
    .report-content blockquote {
      border-left: 3px solid var(--bym-punch);
      background: rgba(254, 110, 0, 0.05);
      padding: 0.75rem 1rem;
      margin: 1rem 0;
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      height: 100%;
      color: var(--text-secondary);
      gap: 0.75rem;
      text-align: center;
      padding: 2rem;
    }
    .empty-state svg {
      color: rgba(255, 255, 255, 0.1);
      width: 48px;
      height: 48px;
    }
    .success-text {
      color: #00c758;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-logo">
      BookYourMat <span class="badge">Session Diagnostics</span>
    </div>
    <div style="font-size: 0.85rem; color: var(--text-secondary)">
      Connected: <strong style="color: var(--text-primary)">phx_...</strong> (Project 334176)
    </div>
  </header>
  
  <div class="container">
    <!-- Left Panel: Recent Sessions -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Recent Onboarding Replays</div>
        <input type="text" id="searchInput" class="search-input" placeholder="Filter by email or city...">
      </div>
      <div class="table-container">
        <table id="sessionsTable">
          <thead>
            <tr>
              <th>Start Time</th>
              <th>User Email</th>
              <th>Location</th>
              <th>Duration</th>
              <th>Activity</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="sessionsList">
            <!-- Loaded dynamically -->
          </tbody>
        </table>
      </div>
    </div>
    
    <!-- Right Panel: Analysis Report -->
    <div class="panel report-panel">
      <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
        <div style="font-weight: 600;" id="loadingStatus">Fetching snapshots...</div>
      </div>
      <div class="panel-header">
        <div class="panel-title" id="reportTitle">Onboarding Report Analysis</div>
      </div>
      <div class="report-content" id="reportDisplay">
        <div class="empty-state">
          <svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"></path>
          </svg>
          <div>No session analyzed yet</div>
          <small>Pick a session from the list on the left to decompress and parse its timeline.</small>
        </div>
      </div>
    </div>
  </div>

  <script>
    let allSessions = [];
    
    async function loadSessions() {
      const tbody = document.getElementById('sessionsList');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">Loading sessions...</td></tr>';
      
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to load');
        allSessions = await res.json();
        renderTable(allSessions);
      } catch (err) {
        tbody.innerHTML = \`<tr><td colspan="6" style="text-align: center; color: #ff2357;">Error loading sessions: \${err.message}</td></tr>\`;
      }
    }
    
    function renderTable(sessions) {
      const tbody = document.getElementById('sessionsList');
      if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary);">No sessions found</td></tr>';
        return;
      }
      
      tbody.innerHTML = sessions.map(s => {
        const timeStr = new Date(s.start_time).toLocaleString();
        const email = s.person?.properties?.email || s.person?.name || 'Anonymous';
        const geoip = s.person?.properties?.$geoip_city_name || '';
        const country = s.person?.properties?.$geoip_country_code || '';
        const location = geoip ? \`\${geoip} (\${country})\` : 'Unknown';
        const duration = s.duration ? \`\${Math.round(s.duration)}s\` : '0s';
        const activity = \`🖱️ \${s.click_count || 0}   ⌨️ \${s.keypress_count || 0}\`;
        
        return \`
          <tr>
            <td style="font-size:0.75rem;">\${timeStr}</td>
            <td><strong style="color:var(--text-accent);">\${email}</strong></td>
            <td>\${location}</td>
            <td>\${duration}</td>
            <td style="font-size:0.75rem;">\${activity}</td>
            <td>
              <button class="btn-analyze" onclick="analyzeSession('\${s.id}', '\${email}')">Analyze</button>
            </td>
          </tr>
        \`;
      }).join('');
    }
    
    async function analyzeSession(id, email) {
      const overlay = document.getElementById('loadingOverlay');
      const status = document.getElementById('loadingStatus');
      const display = document.getElementById('reportDisplay');
      const title = document.getElementById('reportTitle');
      
      overlay.style.display = 'flex';
      status.innerText = 'Downloading & Decompressing Blobs...';
      
      try {
        const res = await fetch(\`/api/analyze?id=\${id}\`);
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Server error');
        }
        const data = await res.json();
        
        title.innerHTML = \`Analysis Report: <span class="success-text">\${email}</span>\`;
        
        // Parse markdown to HTML using the marked library
        display.innerHTML = marked.parse(data.markdown);
      } catch (err) {
        alert('Analysis failed: ' + err.message);
      } finally {
        overlay.style.display = 'none';
      }
    }
    
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const filtered = allSessions.filter(s => {
        const email = (s.person?.properties?.email || s.person?.name || '').toLowerCase();
        const city = (s.person?.properties?.$geoip_city_name || '').toLowerCase();
        return email.includes(query) || city.includes(query);
      });
      renderTable(filtered);
    });
    
    loadSessions();
  </script>
</body>
</html>`);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Developer Session Analyzer Dashboard is running!`);
  console.log(`👉 Open http://localhost:${PORT} in your browser.`);
  console.log(`======================================================\n`);
});
