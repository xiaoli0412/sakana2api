'use strict';
// Public, unauthenticated endpoints, extracted from server.js (P2 split).
//
// The panel, /health and character-card avatars are intentionally reachable
// before the auth gate: <img> tags cannot send authorization headers, and the
// health probe must work for deployment tooling. Everything moved verbatim;
// routing order stays in server.js.

function memorySnapshot() {
  const mem = process.memoryUsage();
  const mib = (value) => Math.round(value / 1048576);
  return {
    rssMB: mib(mem.rss),
    heapUsedMB: mib(mem.heapUsed),
    heapTotalMB: mib(mem.heapTotal),
    externalMB: mib(mem.external),
    arrayBuffersMB: mib(mem.arrayBuffers),
  };
}

function createPublicRoutes({ fs, uiHtmlPath, version, cardDir, loadCard, sendJson }) {
  function index(req, res) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(fs.readFileSync(uiHtmlPath, 'utf8'));
  }

  function health(req, res) {
    return sendJson(res, 200, { ok: true, version, uptimeSec: Math.floor(process.uptime()), memory: memorySnapshot() });
  }

  function avatar(req, res, p) {
    const id = decodeURIComponent(p.slice('/api/characters/'.length, -'/avatar'.length));
    const card = loadCard(cardDir, id);
    if (!card || !card.avatarPath || !fs.existsSync(card.avatarPath)) return sendJson(res, 404, { error: { message: 'avatar not found' } });
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
    return res.end(fs.readFileSync(card.avatarPath));
  }

  return { index, health, avatar };
}

module.exports = { createPublicRoutes, memorySnapshot };