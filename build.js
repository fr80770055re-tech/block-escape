// Builds the single-file game: node build.js  ->  block-escape.html
const fs = require('fs');
const path = require('path');
const r = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const html = r('src/template.html')
  .replace('/*THREE*/', () => r('vendor/three.min.js'))
  .replace('/*LEVEL*/', () => r('src/level.js'))
  .replace('/*GAME*/', () => r('src/game.js'));
// block-escape.html: the file to double-click offline; index.html: served by GitHub Pages
for (const out of ['block-escape.html', 'index.html']) fs.writeFileSync(path.join(__dirname, out), html);
console.log('wrote block-escape.html + index.html', html.length, 'bytes');
