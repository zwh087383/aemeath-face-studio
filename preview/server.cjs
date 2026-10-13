const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.FACE_PREVIEW_PORT || 18765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FACE_PREVIEW_PORT');
const routes = [
  ['/node_modules/', path.join(__dirname, 'node_modules')],
  ['/model/', path.join(root, 'assets', 'Aemeath')],
  ['/audio/', path.join(root, 'audio')],
  ['/data/', path.join(root, 'outputs')],
];
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg','.bmp':'image/bmp','.pmx':'application/octet-stream'};
http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'POST' && ['/save-contact-sheet','/export-sheet'].includes(url.pathname)) {
      if (req.headers.origin !== `http://127.0.0.1:${port}` || req.headers['content-type'] !== 'image/png') { res.writeHead(403).end(); return; }
      let size=0; const chunks=[];
      req.on('data', chunk => { size += chunk.length; if(size > 16000000) req.destroy(); else chunks.push(chunk); });
      req.on('end', () => {
        const png = Buffer.concat(chunks);
        if(png.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') { res.writeHead(400).end(); return; }
        const filename = url.pathname === '/export-sheet' ? 'expression-contact-sheet.png' : 'preview-contact-sheet.png';
        fs.writeFileSync(path.join(root,'outputs',filename),png);
        res.writeHead(200, {'Content-Type':'application/json'}).end('{"saved":true}');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const name = decodeURIComponent(url.pathname).replaceAll('\\','/');
    const route = routes.find(([prefix])=>name.startsWith(prefix));
    const base = route ? route[1] : __dirname;
    let relative = route ? name.slice(route[0].length) : name === '/' ? 'index.html' : name.slice(1);
    if (!route && relative.endsWith('/')) relative += 'index.html';
    const file = path.resolve(base, relative);
    if (!file.toLowerCase().startsWith(base.toLowerCase()+path.sep)) { res.writeHead(403).end(); return; }
    const stat = fs.statSync(file);
    if (!stat.isFile()) { res.writeHead(404).end(); return; }
    let start=0, end=stat.size-1, status=200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) { res.writeHead(416).end(); return; }
      start=Number(match[1]); if(match[2]) end=Math.min(end,Number(match[2]));
      if (start>end) { res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end(); return; }
      status=206;
    }
    const headers={'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream',
      'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
    if(status===206) headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status,headers);
    if(req.method==='HEAD') res.end(); else fs.createReadStream(file,{start,end}).pipe(res);
  } catch { if(!res.headersSent) res.writeHead(404); res.end('Not found'); }
}).listen(port,'127.0.0.1',()=>console.log(`Audio2Face character preview: http://127.0.0.1:${port}`));
