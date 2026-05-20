/**
 * sync_html.mjs
 * 部署前自动把 dashboard_server.mjs 里的 HTML 模板同步到 cloudflare-worker.mjs
 * 用法: node sync_html.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const serverPath = join(dir, 'dashboard_server.mjs');
const workerPath = join(dir, 'cloudflare-worker.mjs');

function extractHtml(src) {
  const start = src.indexOf('const html = `');
  if (start === -1) return null;
  const end = src.indexOf('</html>`;', start);
  if (end === -1) return null;
  return src.slice(start, end + '</html>`;'.length);
}

const server = fs.readFileSync(serverPath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');

const serverHtml = extractHtml(server);
const workerHtml = extractHtml(worker);

if (!serverHtml) { console.error('[sync_html] html template not found in dashboard_server.mjs'); process.exit(1); }
if (!workerHtml) { console.error('[sync_html] html template not found in cloudflare-worker.mjs'); process.exit(1); }

if (serverHtml === workerHtml) {
  console.log('[sync_html] HTML templates already in sync, no change needed.');
  process.exit(0);
}

const updated = worker.replace(workerHtml, serverHtml);
if (updated === worker) { console.error('[sync_html] replacement had no effect'); process.exit(1); }

fs.writeFileSync(workerPath, updated, 'utf8');
console.log(`[sync_html] done — server: ${serverHtml.length} bytes → worker: ${workerHtml.length} bytes`);
