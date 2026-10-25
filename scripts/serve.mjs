import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
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
    res.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'text/plain','Cache-Control':'no-store'}); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
const host = process.env.HOST || '127.0.0.1';
server.listen(Number(process.env.PORT) || 4173, host, () => console.log('Crate Swipe → http://' + host + ':' + server.address().port));
