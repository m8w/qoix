#!/usr/bin/env node
/* ============================================================
   QOIX Synthesizer — standalone single-file build
   ============================================================
   Inlines every js/*.js referenced by index.html into
   qoix-standalone.html so the app can be opened straight from
   disk (or dropped on a static host) without the js/ folder.

   Usage: npm run build:standalone
   ============================================================ */

'use strict';

const fs   = require('fs');
const path = require('path');

const root   = path.join(__dirname, '..');
const source = path.join(root, 'index.html');
const target = path.join(root, 'qoix-standalone.html');

const html = fs.readFileSync(source, 'utf8');

let inlined = 0;
const out = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, rel) => {
  const js = fs.readFileSync(path.join(root, rel), 'utf8');
  inlined++;
  return '<script>\n' + js + '\n</script>';
});

if (!inlined) {
  console.error('No <script src="js/…"> tags found in index.html — nothing to inline.');
  process.exit(1);
}

fs.writeFileSync(target, out, 'utf8');
console.log(`[QOIX] qoix-standalone.html rebuilt — ${inlined} scripts inlined, ${(out.length / 1024).toFixed(0)} kB`);
