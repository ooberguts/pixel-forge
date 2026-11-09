import { isTauri, invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

export const desktop = isTauri();
export async function saveBytes(bytes: Uint8Array, name: string, extension: string) {
  if (desktop) {
    const path = await save({
      defaultPath: name,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}
export async function checkUpdates(onStatus: (s: string) => void, silent = false) {
  if (!desktop) {
    if (!silent) onStatus('Desktop updates will be available in the installed app.');
    return null;
  }
  const configured = await invoke<boolean>('updater_configured');
  if (!configured) {
    if (!silent)
      onStatus(
        'Updates are ready to connect after the GitHub repository and signing key are configured.',
      );
    return null;
  }
  const { check } = await import('@tauri-apps/plugin-updater');
  if (!silent) onStatus('Checking GitHub Releases…');
  const update = await check({ timeout: 15000 });
  if (!silent)
    onStatus(
      update
        ? `Version ${update.version} is ready to install.`
        : 'You are using the latest version.',
    );
  return update;
}
