// Local-only preview: runs the real add-in page against a made-up fleet and a fake MyGeotab API.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const base = path.join(__dirname, '..');

http.createServer((req, res) => {
  if (req.url !== '/') {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  const client = fs.readFileSync(path.join(__dirname, 'mock-mygeotab.js'), 'utf8');
  const page = fs.readFileSync(path.join(base, 'fleetWolfActionPanel.html'), 'utf8');
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(page.replace('</body>', () => `<script>${client}</script></body>`));
}).listen(8766, '127.0.0.1', () => console.log('Demo at http://127.0.0.1:8766'));
