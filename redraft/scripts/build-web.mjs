// Build the browser / PWA version into web-dist/redraft (served on GitHub Pages at /redraft/).
// It mirrors the Electron layout (src/ + the node_modules files the app uses), with an
// index.html whose <base href="src/"> keeps every relative path identical.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(root, process.argv[2] || 'web-dist');
const out = path.join(site, 'redraft');
fs.rmSync(site, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (rel, to = rel) => {
  const src = path.join(root, rel), dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
};
const glob = (dir, re) => fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => path.posix.join(dir, f));

// App sources.
copy('src');
// Third-party files the app loads at run time.
const NM = [
  'node_modules/pdfjs-dist/build/pdf.min.js', 'node_modules/pdfjs-dist/build/pdf.worker.min.js',
  'node_modules/pdfjs-dist/cmaps', 'node_modules/pdfjs-dist/standard_fonts',
  'node_modules/pdf-lib/dist/pdf-lib.min.js', 'node_modules/jszip/dist/jszip.min.js',
  'node_modules/mp4-muxer/build/mp4-muxer.js', 'node_modules/webm-muxer/build/webm-muxer.js',
  'node_modules/opentype.js/dist/opentype.min.js',
  'node_modules/tesseract.js/dist/tesseract.min.js', 'node_modules/tesseract.js/dist/worker.min.js',
  ...glob('node_modules/tesseract.js-core', /^tesseract-core(-simd)?-lstm\.wasm\.js$/),
  'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'node_modules/perfect-freehand/dist/esm/index.mjs',
];
for (const f of ['caveat', 'patrick-hand', 'kalam', 'architects-daughter', 'indie-flower', 'gaegu']) {
  const d = `node_modules/@fontsource/${f}`;
  NM.push(...glob(d, /\.css$/), ...glob(`${d}/files`, /-latin-(ext-)?\d+-normal\.woff2?$/));
}
NM.forEach((f) => copy(f));
// PWA files.
copy('web/icons', 'icons');
copy('web/manifest.webmanifest', 'manifest.webmanifest');

// index.html: the Electron page with a <base>, the web entry point and PWA tags.
let html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">
  <base href="src/">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#17171a">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Redraft">
  <link rel="manifest" href="../manifest.webmanifest">
  <link rel="icon" type="image/png" href="../icons/icon-192.png">
  <link rel="apple-touch-icon" href="../icons/apple-touch-icon.png">`);
html = html.replace('src="js/main.js"', 'src="js/web-entry.js"');
html = html.replace("connect-src 'self' blob: data:;", "connect-src 'self' blob: data:; manifest-src 'self';");
if (!html.includes('js/web-entry.js') || !html.includes('<base href="src/">')) throw new Error('index.html template changed: update build-web.mjs');
fs.writeFileSync(path.join(out, 'index.html'), html);

// Service worker with a precache list of every file (big PDF CMap tables are cached on demand).
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(out, p).split(path.sep).join('/'));
  }
};
walk(out);
const precache = ['./', ...files.filter((f) => !/\/(cmaps|standard_fonts)\//.test(f) && !f.endsWith('.d.ts')).map((f) => './' + f)];
const hash = crypto.createHash('sha256');
for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(out, f)));
const version = hash.digest('hex').slice(0, 12);
const sw = fs.readFileSync(path.join(root, 'web/sw-template.js'), 'utf8')
  .replace('__VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 0));
fs.writeFileSync(path.join(out, 'sw.js'), sw);
fs.writeFileSync(path.join(site, '.nojekyll'), '');

const size = files.reduce((s, f) => s + fs.statSync(path.join(out, f)).size, 0);
console.log(`web build: ${files.length} files, ${(size / 1e6).toFixed(1)} MB, ${precache.length} precached, version ${version} -> ${path.relative(root, out)}`);
