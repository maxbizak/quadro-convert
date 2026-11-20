import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rpc, type Port } from '@quadrohub/pc-sdk';
import { buildPart } from '../scripts/build-pc.mjs';

// The built part (dist/pc/part.cjs, pc-sdk bundled in) started the way the program starts an installed part — Node's IPC channel,
// the program's hello — and called the way its screen calls it. Here the test plays the program: it answers the part's own
// calls (files.pick) and has no FFmpeg in the app's folder.

const dirs: string[] = [];
let child: ChildProcess;
let rpc: Rpc;
const events: Array<{ name: string; data: unknown }> = [];

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), 'qh-convert-'));
  dirs.push(work);
  const part = await buildPart(join(work, 'pc', 'part.cjs'));
  const appDir = join(work, 'app');
  const dataDir = join(work, 'data');
  child = fork(part, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const token = 'test-token';
  const port: Port = {
    post: (m) => void child.send(m as never),
    onMessage: (fn) => void child.on('message', fn),
    close: () => child.kill(),
    onClose: (fn) => void child.on('exit', () => fn()),
  };
  rpc = new Rpc(port, token);
  rpc.on('$event', (e) => events.push(e as { name: string; data: unknown }));
  rpc.handle('files.pick', () => ['C:\\media\\clip.mp4']);
  const ready = new Promise<void>((resolve) => rpc.on('$ready', () => resolve()));
  child.send({ type: 'quadro-part', token, appId: 'quadro.convert', dataDir, appDir, config: {} });
  await ready;
}, 60_000);

afterAll(async () => {
  try {
    await rpc.call('$stop', undefined, 5_000);
  } catch {
    // gone
  }
  child?.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the built part of «Конвертер»', () => {
  it('answers its screen: no FFmpeg yet, an empty history, files picked through the program', async () => {
    expect(await rpc.call('status')).toMatchObject({ engine: 'missing', size: 0 });
    expect(await rpc.call('list')).toEqual([]);
    expect(await rpc.call('pickFiles')).toEqual(['C:\\media\\clip.mp4']);
  });

  it('refuses work without its engine, in words for a person', async () => {
    await expect(rpc.call('probe', { path: 'C:\\media\\clip.mp4' })).rejects.toThrow(/FFmpeg не найден/);
    await expect(rpc.call('start', { items: [{ path: 'C:\\media\\clip.mp4', op: 'convert', params: { to: 'mp3' } }] })).rejects.toThrow(/FFmpeg/);
  });

  it('answers the actions over a video of Hub and «/compress» (refusing without its engine)', async () => {
    const object = { kind: 'file', id: '/api/files/1', title: 'clip.mp4', url: '/api/files/1', path: 'C:\\media\\clip.mp4' };
    await expect(rpc.call('actMute', { object: { kind: 'person', id: 'u1', title: 'Аня' }, values: {} })).rejects.toThrow(/с файлом/);
    await expect(rpc.call('actCompress', { object, values: { targetMB: 10 } })).rejects.toThrow(/FFmpeg не найден/);
    await expect(rpc.call('chatCompress', { command: 'compress', values: { targetMB: 10 }, where: { kind: 'dm', conversationId: 'c1' } })).rejects.toThrow(/FFmpeg не найден/);
  });

  it('knows only its own methods', async () => {
    await expect(rpc.call('deleteEverything')).rejects.toThrow(/Нет такого действия/);
  });

  it('is one file: nothing from outside the bundle', () => {
    expect(existsSync(join(dirs[0]!, 'pc', 'part.cjs'))).toBe(true);
  });
});
