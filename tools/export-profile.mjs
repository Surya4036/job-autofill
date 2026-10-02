/* Write local/profile.json from the extension's built-in defaults.
   Run: node tools/export-profile.mjs [--resume /path/to/resume.pdf]

   If you have edited your profile in the extension, prefer its options page ->
   Export JSON, and save the result over local/profile.json instead: that file has
   your actual edits, these are only the defaults compiled into src/store.js. */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// store.js is a classic script that assigns onto self.JA; give it a self to attach to.
globalThis.self = globalThis;
globalThis.CSS = { escape: (s) => s };
// eslint-disable-next-line no-eval
eval(readFileSync(resolve(root, 'src/store.js'), 'utf8'));

const resumeFlag = process.argv.indexOf('--resume');
const resumePath = resumeFlag > -1 ? process.argv[resumeFlag + 1] : '../Surya Prakash SDE Resume.pdf';

const out = {
  profile: JA.DEFAULT_PROFILE,
  snippets: JA.DEFAULT_SNIPPETS,
  settings: { ...JA.DEFAULT_SETTINGS, highlightFilled: false },
  resumePath: resolve(root, resumePath),
};

const target = resolve(root, 'local/profile.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);

const filled = Object.entries(out.profile).filter(([, v]) => String(v).trim()).length;
console.log(`wrote ${target}`);
console.log(`  profile: ${filled}/${Object.keys(out.profile).length} fields set`);
console.log(`  answers: ${out.snippets.filter((s) => s.answer.trim()).length}`);
console.log(`  resume:  ${out.resumePath}`);
