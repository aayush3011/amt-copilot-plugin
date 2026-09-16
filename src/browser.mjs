import { spawn } from 'node:child_process';
import { MemoryHouseError } from './errors.mjs';

export async function openBrowserUrl(value, { signal } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MemoryHouseError('BROWSER_URL_INVALID', 'The sign-in page URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'login.microsoftonline.com' || url.username || url.password || url.hash) {
    throw new MemoryHouseError('BROWSER_URL_INVALID', 'Only Microsoft HTTPS sign-in URLs can be opened.');
  }
  const [command, args] = process.platform === 'darwin' ? ['open', [url.href]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]]
      : ['xdg-open', [url.href]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false, signal });
    const failed = () => reject(new MemoryHouseError('BROWSER_LAUNCH_FAILED', 'Unable to open the Microsoft sign-in browser. Check your default browser and retry memory_login.'));
    child.once('error', failed);
    child.once('exit', code => code === 0 ? resolve() : failed());
  });
}
