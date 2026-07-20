#!/usr/bin/env node
/**
 * Rebuilds the single-file, deployable index.html from the editable sources.
 *
 *   node build.js
 *
 * How it works:
 *   - shell.html is the original bundled file. It carries the asset manifest
 *     (fonts, React) and the loader script. It is never edited by hand.
 *   - src/template.html is the app markup. It contains two markers,
 *     /*__OT_DATA__*​/ and /*__APP_LOGIC__*​/, where the other two sources
 *     are injected at build time.
 *   - src/data.js is the seed dataset (window.__OT_DATA = {...}).
 *   - src/app_logic.js is the app component (state, Supabase sync, handlers).
 *
 * The assembled template is JSON-encoded (with </script> escaped as
 * </script> so it can live inside a <script> tag) and swapped into
 * shell.html's __bundler/template block. The result is written to index.html.
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const shell = read('shell.html');
const markup = read('src/template.html');
const data = read('src/data.js');
const logic = read('src/app_logic.js');

for (const [marker, name] of [['/*__OT_DATA__*/', 'src/data.js'], ['/*__APP_LOGIC__*/', 'src/app_logic.js']]) {
  if (!markup.includes(marker)) {
    console.error(`ERROR: src/template.html is missing the ${marker} marker (injection point for ${name}).`);
    process.exit(1);
  }
}

const template = markup
  .replace('/*__OT_DATA__*/', () => data)
  .replace('/*__APP_LOGIC__*/', () => logic);

const encoded = '\n' + JSON.stringify(template).replace(/<\/script/gi, '\\u003c/script') + '\n';

const tag = '<script type="__bundler/template">';
const start = shell.indexOf(tag);
if (start === -1) {
  console.error('ERROR: shell.html has no __bundler/template block.');
  process.exit(1);
}
const bodyStart = start + tag.length;
const bodyEnd = shell.indexOf('</script>', bodyStart);

let out = shell.slice(0, bodyStart) + encoded + shell.slice(bodyEnd);

// --- Link-preview / social-unfurl tags -------------------------------------
// These make the URL expand into a rich card (title, blurb, thumbnail) when
// pasted into Teams, Slack, etc. Crawlers read the static <head> without
// running JS, so the tags must live in the served HTML head — injected here
// on every build so they survive shell replacements. Edit SITE_URL if the
// deployed address changes.
const SITE_URL = 'https://ot-dashboard.netlify.app';
const META = `
  <title>WWT OT Tracker</title>
  <meta name="description" content="Live outbound tracking — capacity, location map, and per-location status.">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WWT">
  <meta property="og:title" content="WWT OT Tracker">
  <meta property="og:description" content="Live outbound tracking — capacity, location map, and per-location status.">
  <meta property="og:url" content="${SITE_URL}/">
  <meta property="og:image" content="${SITE_URL}/preview.png">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="WWT OT Tracker dashboard">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="WWT OT Tracker">
  <meta name="twitter:description" content="Live outbound tracking — capacity, location map, and per-location status.">
  <meta name="twitter:image" content="${SITE_URL}/preview.png">
`;
out = out.replace(/\s*<title>[^<]*<\/title>/i, '');           // drop shell's placeholder title
out = out.replace(/(<meta charset=["'][^"']*["']>)/i, `$1${META}`);

fs.writeFileSync(path.join(root, 'index.html'), out);

// Sanity check: the built file must decode back to the exact template we assembled.
const check = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cStart = check.indexOf(tag) + tag.length;
const decoded = JSON.parse(check.slice(cStart, check.indexOf('</script>', cStart)));
if (decoded !== template) {
  console.error('ERROR: round-trip check failed — index.html may be corrupt.');
  process.exit(1);
}

console.log(`Built index.html (${(out.length / 1024).toFixed(1)} KB) — template ${(template.length / 1024).toFixed(1)} KB, round-trip check passed.`);
