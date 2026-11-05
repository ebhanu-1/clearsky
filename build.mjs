// Inlines src/ into one self-contained index.html (no CDN, no network at load).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const js = ['src/core.js', 'src/providers.js', 'src/format.js', 'src/app.js'].map(read).join('\n');
import vm from 'node:vm';
new vm.Script(js, { filename: 'bundle.js' }); // fails the build on a syntax error
if (/<\/script/i.test(js)) throw new Error('script text contains </script');
const html = read('src/index.template.html').replace('/*__CSS__*/', () => read('src/style.css')).replace('/*__JS__*/', () => js);

fs.writeFileSync(path.join(root, 'index.html'), html);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/index.html'), html);
for (const f of fs.readdirSync(path.join(root, 'public'))) fs.copyFileSync(path.join(root, 'public', f), path.join(root, f));
const gz = zlib.gzipSync(html).length;
console.log(`index.html ${(html.length / 1024).toFixed(1)} KB, ${(gz / 1024).toFixed(1)} KB gzipped (budget 200 KB gzipped)`);
if (gz > 200 * 1024) { console.error('over budget'); process.exit(1); }
