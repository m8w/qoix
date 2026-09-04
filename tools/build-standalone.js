#!/usr/bin/env node
/* ============================================================
   QOIX Synthesizer — standalone single-file build
   ============================================================
   Inlines styles.css and every js/*.js referenced by
   index.html into qoix-standalone.html, so the single file runs
   on its own — opened straight from disk, mailed, or dropped on
   a static host — with nothing else beside it.

   Usage: npm run build:standalone
   ============================================================ */

'use strict';

const fs   = require('fs');
const path = require('path');

const root   = path.join(__dirname, '..');
const source = path.join(root, 'index.html');
const target = path.join(root, 'qoix-standalone.html');

const html = fs.readFileSync(source, 'utf8');

// Stylesheet first — without it every .tab-panel is visible at once, since
// the tab switching relies on `.tab-panel { display: none }`.
let styles = 0;
let out = html.replace(/<link rel="stylesheet" href="([^"]+)"\s*\/?>/g, (_, rel) => {
  const css = fs.readFileSync(path.join(root, rel), 'utf8');
  styles++;
  return '<style>\n' + css + '</style>';
});

let inlined = 0;
out = out.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, rel) => {
  const js = fs.readFileSync(path.join(root, rel), 'utf8');
  inlined++;
  return '<script>\n' + js + '\n</script>';
});

if (!inlined || !styles) {
  console.error(`Nothing to inline (stylesheets: ${styles}, scripts: ${inlined}) — check index.html.`);
  process.exit(1);
}

fs.writeFileSync(target, out, 'utf8');
console.log(`[QOIX] qoix-standalone.html rebuilt — ${styles} stylesheet + ${inlined} scripts inlined, ${(out.length / 1024).toFixed(0)} kB`);
