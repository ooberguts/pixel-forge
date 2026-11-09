import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifest } from './updater-manifest.mjs';
function fixture() {
  const names = [
    'Pixel.Forge_0.2.1_aarch64.app.tar.gz',
    'Pixel.Forge_0.2.1_x64.app.tar.gz',
    'Pixel.Forge_0.2.1_x64-setup.exe',
  ];
  const assets = names
    .flatMap((name) => [name, name + '.sig'])
    .map((name) => ({
      name,
      size: 100,
      browser_download_url:
        'https://github.com/ooberguts/pixel-forge/releases/download/v0.2.1/' + name,
    }));
  return {
    release: { tag_name: 'v0.2.1', created_at: '2026-11-09T00:00:00Z', body: 'Changes', assets },
    signatures: Object.fromEntries(names.map((name) => [name + '.sig', 'signed-' + name])),
  };
}
test('combines platform-specific artifacts without concurrent metadata writes', () => {
  const { release, signatures } = fixture(),
    manifest = createManifest(release, signatures, '0.2.1');
  assert.equal(Object.keys(manifest.platforms).length, 6);
  assert.ok(manifest.platforms['windows-x86_64'].url.endsWith('_x64-setup.exe'));
  assert.equal(
    manifest.platforms['darwin-aarch64-app'].signature,
    signatures['Pixel.Forge_0.2.1_aarch64.app.tar.gz.sig'],
  );
});
test('refuses to publish an incomplete platform set or missing signatures', () => {
  const { release, signatures } = fixture();
  delete signatures['Pixel.Forge_0.2.1_x64-setup.exe.sig'];
  assert.throws(() => createManifest(release, signatures, '0.2.1'));
});
test('rejects mismatched tags and updater download origins', () => {
  const { release, signatures } = fixture();
  assert.throws(() => createManifest(release, signatures, '0.9.0'));
  release.assets[0].browser_download_url = 'https://example.org/update';
  assert.throws(() => createManifest(release, signatures, '0.2.1'));
});
