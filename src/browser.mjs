import { spawn } from 'node:child_process';
import { MemoryHouseError } from './errors.mjs';

export async function openBrowserUrl(value, { signal, allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MemoryHouseError('BROWSER_URL_INVALID', 'The sign-in page URL is invalid.');
  }
  const local = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port;
  if ((!local && url.protocol !== 'https:') || url.username || url.password) {
    throw new MemoryHouseError('BROWSER_URL_INVALID', 'Only HTTPS sign-in pages or the local setup page can be opened.');
  }
  const [command, args] = process.platform === 'darwin' ? ['open', [url.href]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]]
      : ['xdg-open', [url.href]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, shell: false, signal });
    const failed = () => reject(new MemoryHouseError('BROWSER_LAUNCH_FAILED', 'Unable to open a browser. Open the local Memory House sign-in link yourself.'));
    child.once('error', failed);
    child.once('exit', code => code === 0 ? resolve() : failed());
  });
}
