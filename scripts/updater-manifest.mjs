import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createManifest(release, signatures, version) {
  if (release.tag_name !== `v${version}`) throw Error('Release tag does not match app version');
  const platforms = {};
  for (const [target, suffix, bundle] of [
    ['darwin-aarch64', '_aarch64.app.tar.gz', 'app'],
    ['darwin-x86_64', '_x64.app.tar.gz', 'app'],
    ['windows-x86_64', '_x64-setup.exe', 'nsis'],
  ]) {
    const matches = release.assets.filter((asset) => asset.name.endsWith(suffix));
    if (matches.length !== 1) throw Error('Expected one updater artifact for ' + target);
    const asset = matches[0];
    const signatureName = asset.name + '.sig';
    const signature = signatures[signatureName]?.trim();
    const prefix = `https://github.com/ooberguts/pixel-forge/releases/download/v${version}/`;
    if (
      !asset.browser_download_url.startsWith(prefix) ||
      !asset.size ||
      !signature ||
      !release.assets.some((item) => item.name === signatureName)
    ) {
      throw Error('Missing signature or invalid release URL for ' + target);
    }
    platforms[target] = { url: asset.browser_download_url, signature };
    platforms[`${target}-${bundle}`] = platforms[target];
  }
  return {
    version,
    notes: release.body || '',
    pub_date: release.published_at || release.created_at,
    platforms,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const directory = process.argv[3];
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const signatures = Object.fromEntries(
    release.assets
      .filter((a) => a.name.endsWith('.sig'))
      .map((a) => {
        if (a.name.includes('/') || a.name.includes('\\'))
          throw Error('Invalid signature filename');
        return [a.name, readFileSync(join(directory, a.name), 'utf8')];
      }),
  );
  writeFileSync(
    'latest.json',
    JSON.stringify(createManifest(release, signatures, version), null, 2) + '\n',
  );
  console.log('Created combined updater manifest for all desktop platforms.');
}
