import { writeFileSync } from 'node:fs';

const repo = process.env.GITHUB_REPOSITORY;
const pubkey = process.env.TAURI_UPDATER_PUBLIC_KEY;
if (!repo || !/^[-\w.]+\/[-\w.]+$/.test(repo) || !pubkey?.trim()) {
  throw new Error(
    'Set GITHUB_REPOSITORY=owner/repo and TAURI_UPDATER_PUBLIC_KEY to the Tauri public key content.',
  );
}
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: {
    updater: {
      pubkey: pubkey.trim(),
      endpoints: [`https://github.com/${repo}/releases/latest/download/latest.json`],
      windows: { installMode: 'passive' },
    },
  },
};
// Merge this file explicitly with --config. No private keys are written here.
writeFileSync(
  new URL('../src-tauri/tauri.updater.conf.json', import.meta.url),
  JSON.stringify(config, null, 2) + '\n',
);
console.log(
  'Updater configuration created for ' +
    repo +
    '. Build with --config src-tauri/tauri.updater.conf.json',
);
