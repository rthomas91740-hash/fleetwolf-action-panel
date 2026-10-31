const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const base = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(base, 'build.js')]);
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
const html = manifest.files['fleetWolfActionPanel.html'];

test('manifest installs one page named Fleet Wolf Action Panel', () => {
  assert.equal(manifest.name, 'Fleet Wolf Action Panel');
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].url, 'fleetWolfActionPanel.html');
  assert.equal(manifest.items[0].menuName.en, 'Fleet Wolf Action Panel');
});

test('page is self-contained, injects styles from script and holds no customer or demo data', () => {
  assert.ok(html.includes('fwActionPanelStyle'));
  assert.ok(html.includes('window.geotab.addin.fleetWolfActionPanel'));
  assert.ok(!/<style[\s>]/i.test(html));
  assert.ok(!/<link\s|src=["']http/i.test(html));
  assert.ok(!/citadel|solar|demo fleet/i.test(html));
  assert.ok(!/innerHTML/.test(html));
});

test('page carries the support line and tucks data notes behind the info box', () => {
  assert.ok(html.includes('class="fw-signature"'));
  assert.ok(html.includes('mailto:randy@fleetwolf.com'));
  assert.ok(html.includes('For data set info, click here'));
});

test('short config points at the published page', () => {
  const text = fs.readFileSync(path.join(base, 'addin-config.json'), 'utf8');
  const config = JSON.parse(text);
  assert.ok(text.length < 50000);
  assert.equal(config.files, undefined);
  assert.match(config.items[0].url, /^https:\/\/.+\/index\.html$/);
  assert.equal(fs.readFileSync(path.join(base, 'index.html'), 'utf8'), html);
});

test('script compiles', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

test('storage id is an encoded 16-byte GUID as MyGeotab expects', () => {
  const id = html.match(/ADD_IN_ID = '([^']+)'/)[1];
  assert.equal(id[0], 'a');
  assert.equal(Buffer.from(id.slice(1), 'base64url').length, 16);
});
