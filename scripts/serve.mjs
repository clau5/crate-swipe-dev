import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) throw Error('path');
    // Never expose version-control metadata or local credentials.
    if (path.relative(root, file).split(path.sep).some(p => p.startsWith('.'))) throw Error('hidden');
    const data = await readFile(file);
    // 3.1.9: revalidate instead of no-store (a repeat open costs 304s, not full downloads) and gzip text,
    // which matters on hosts that serve this file directly (Ample). Always fresh: no-cache + ETag.
    const etag = '"' + createHash('sha1').update(data).digest('base64url').slice(0,16) + '"';
    const headers = {'Content-Type':mime[path.extname(file)] || 'text/plain','Cache-Control':'no-cache','ETag':etag,'Vary':'Accept-Encoding'};
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const text = /^(text\/|application\/json|image\/svg)/.test(headers['Content-Type']);
    if (text && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, {...headers,'Content-Encoding':'gzip'}); return res.end(gzipSync(data)); }
    res.writeHead(200, headers); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const host = process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT) || 4173, host, () => console.log('Crate Swipe → http://' + host + ':' + server.address().port));
