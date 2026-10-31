const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, 'src', file), 'utf8');
// MyGeotab drops <style> tags from embedded Add-In pages but runs their scripts, so styles are injected from script.
const css = JSON.stringify(read('style.css')).replace(/<\//g, '<\\/');
const styleLoader = `(function () {\n  if (document.getElementById('fwActionPanelStyle')) return;\n  const style = document.createElement('style');\n  style.id = 'fwActionPanelStyle';\n  style.textContent = ${css};\n  document.head.appendChild(style);\n})();`;
const html = read('page.html').replace('<!-- CODE -->', () => `<script>\n${styleLoader}\n${read('core.js')}\n${read('app.js')}\n</script>`);

fs.writeFileSync(path.join(__dirname, 'fleetWolfActionPanel.html'), html);
const configuration = {
  name: 'Fleet Wolf Action Panel',
  supportEmail: 'randy@fleetwolf.com',
  version: '1.0.0',
  items: [{ url: 'fleetWolfActionPanel.html', path: 'ActivityLink', category: 'AddIns', menuName: { en: 'Fleet Wolf Action Panel' } }],
  files: { 'fleetWolfActionPanel.html': html },
  isSigned: false,
};
fs.writeFileSync(path.join(__dirname, 'manifest.json'), `${JSON.stringify(configuration, null, 2)}\n`);
// The add-in is hosted on GitHub Pages, so the page is also published as index.html and the short config points at it.
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
const hosted = { ...configuration, items: [{ ...configuration.items[0], url: 'https://rthomas91740-hash.github.io/fleetwolf-action-panel/index.html' }] };
delete hosted.files;
fs.writeFileSync(path.join(__dirname, 'addin-config.json'), `${JSON.stringify(hosted, null, 2)}\n`);
console.log('Built fleetWolfActionPanel.html, index.html, manifest.json and addin-config.json.');
