import { constants, lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { MemoryHouseError } from './errors.mjs';

const noFollow = constants.O_NOFOLLOW ?? 0;
const fail = (code, message) => new MemoryHouseError(code, message);
export const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

export async function inspect(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('STATE_IO_ERROR', 'Unable to inspect Memory House state. Check directory permissions.');
  }
}

function regularFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owned(stat)) {
    throw fail('UNSAFE_STATE', 'Memory House state must use owned regular files, not symbolic or hard links.');
  }
}

export function inspectDirectorySync(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
      throw fail('UNSAFE_STATE', 'Memory House state must be an owned directory, not a symbolic link.');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    if (error instanceof MemoryHouseError) throw error;
    throw fail('STATE_IO_ERROR', 'Unable to inspect Memory House state. Check directory permissions.');
  }
}

export async function ensureDirectory(path) {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
      throw fail('UNSAFE_STATE', 'Memory House state must be an owned directory, not a symbolic link.');
    }
    if (process.platform !== 'win32') await chmod(path, 0o700);
  } catch (error) {
    if (error instanceof MemoryHouseError) throw error;
    throw fail('STATE_IO_ERROR', 'Unable to secure Memory House state. Check directory permissions.');
  }
}

function checkOpened(before, opened) {
  regularFile(opened);
  if (opened.ino !== before.ino || opened.dev !== before.dev) {
    throw fail('UNSAFE_STATE', 'Memory House state changed while being read. Try again after other clients stop.');
  }
}

export async function readState(path, maxBytes = 128 * 1024) {
  let handle;
  try {
    const stat = await inspect(path);
    if (!stat) return null;
    regularFile(stat);
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    checkOpened(stat, opened);
    if (opened.size > maxBytes) throw fail('INVALID_CACHE', 'Memory House state is oversized. Sign in again.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw fail('INVALID_CACHE', 'Memory House state is oversized. Sign in again.');
    return buffer.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error instanceof MemoryHouseError) throw error;
    if (error.code === 'ENOENT') return null;
    throw fail('STATE_IO_ERROR', 'Unable to read Memory House state. Check directory permissions.');
  } finally {
    if (handle) await handle.close();
  }
}

export async function removeFile(path) {
  const stat = await inspect(path);
  if (!stat) return;
  regularFile(stat);
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw fail('STATE_IO_ERROR', 'Unable to clear local Memory House state.');
  }
}

export async function atomicJson(path, value) {
  const existing = await inspect(path);
  if (existing) regularFile(existing);
  const staging = join(dirname(path), `.${basename(path)}.${randomUUID()}.write`);
  let handle;
  let created = false;
  try {
    handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(staging, path);
    created = false;
    if (process.platform !== 'win32') {
      const directoryHandle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    if (error instanceof MemoryHouseError) throw error;
    throw fail('STATE_IO_ERROR', 'Unable to persist Memory House state securely. Sign in again if a token was rotated.');
  } finally {
    if (handle) await handle.close();
    if (created) await removeFile(staging);
  }
}

export async function withLock(path, timeoutMs, work) {
  const start = performance.now();
  const owner = { nonce: randomUUID(), pid: process.pid, host: hostname() };
  let acquired = false;
  let identity;
  while (!acquired) {
    try {
      await mkdir(path, { mode: 0o700 });
      acquired = true;
      identity = await lstat(path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw fail('LOCK_ERROR', 'Unable to acquire the Memory House state lock.');
      const stat = await inspect(path);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) {
        throw fail('UNSAFE_LOCK', 'Refusing to use an unsafe Memory House state lock.');
      }
      if (performance.now() - start >= timeoutMs) {
        throw fail(
          'LOCK_TIMEOUT',
          `Timed out waiting for another Memory House operation. If a client crashed, stop all clients before removing its ${basename(path)} directory.`,
        );
      }
      await sleep(Math.min(25, Math.max(1, timeoutMs - (performance.now() - start))));
    }
  }
  const ownerPath = join(path, 'owner.json');
  try {
    await atomicJson(ownerPath, owner);
    return await work();
  } finally {
    // Never age-evict an auth lock: the owner may still be writing a rotated token.
    const current = await inspect(path);
    if (!current || current.ino !== identity.ino || current.dev !== identity.dev) {
      throw fail('LOCK_OWNERSHIP_LOST', 'Memory House lock ownership changed; the replacement lock was not removed.');
    }
    const raw = await readState(ownerPath, 4096);
    let record;
    try {
      record = raw === null ? null : JSON.parse(raw);
    } catch {
      throw fail('LOCK_OWNERSHIP_LOST', 'Memory House lock ownership cannot be verified; the lock was not removed.');
    }
    if (record?.nonce !== owner.nonce || record?.pid !== owner.pid || record?.host !== owner.host) {
      throw fail('LOCK_OWNERSHIP_LOST', 'Memory House lock ownership changed; the lock was not removed.');
    }
    await removeFile(ownerPath);
    try {
      await rmdir(path);
    } catch {
      throw fail('LOCK_ERROR', 'Memory House lock contains unexpected state and was not removed.');
    }
  }
}
