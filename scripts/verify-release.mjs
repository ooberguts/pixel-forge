import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2] || 'latest.json', 'utf8'));
const expected = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (manifest.version?.replace(/^v/, '') !== expected)
  throw Error('Updater manifest version mismatch');
for (const target of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
  const asset = manifest.platforms?.[target];
  if (
    !asset?.signature ||
    !asset.url?.startsWith(
      `https://github.com/ooberguts/pixel-forge/releases/download/v${expected}/`,
    )
  )
    throw Error('Missing or invalid signed asset for ' + target);
}
console.log('Updater manifest contains all three signed desktop targets.');
