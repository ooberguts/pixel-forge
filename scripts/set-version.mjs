import { readFileSync, writeFileSync } from 'node:fs';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Usage: npm run version:set -- 0.2.0');
for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
  const text = readFileSync(file, 'utf8');
  const next = file.endsWith('.toml')
    ? text.replace(/^version = "[^"]+"/m, `version = "${version}"`)
    : text.replace(/(\[\[package\]\]\nname = "pixel-forge"\nversion = ")[^"]+"/, `$1${version}"`);
  writeFileSync(file, next);
}
console.log(
  `Version set to ${version}. Commit, tag v${version}, and push main plus the tag to release.`,
);
