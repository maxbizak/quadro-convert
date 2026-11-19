import { join } from 'node:path';
import { connect, type PartHostApi } from '@quadrohub/pc-sdk';
import { ConvertEngine, type EngineFiles, type Item } from './engine';

// «Конвертер»'s part on the PC, a package of the catalog like any author's (docs/apps/convert.md): FFmpeg is its download
// (manifest `parts.pc.downloads`, unpack: 'zip' — the program fetches, checks and unpacks it at «Поставить»); the person's files
// come through the program (pc.files.pick / reveal / open), its programs are its own (pc.process).

export const CONVERT_METHODS = ['status', 'install', 'probe', 'pickFiles', 'pickFolder', 'start', 'cancel', 'list', 'reveal', 'open', 'settings', 'setSettings'] as const;

/** FFmpeg of its manifest: the download's id and where its programs lie in the unpacked archive. */
export const FFMPEG = { download: 'ffmpeg', version: '9.0.2', bin: 'ffmpeg-9.0.2-essentials_build/bin' } as const;

/** What it reads, picks and opens. */
export const MEDIA = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv', 'mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'wma', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'gif', 'ico'];

export function serveConvert(host: PartHostApi, engine: ConvertEngine): void {
  const obj = (x: unknown) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
  host.rpc.handle('status', () => engine.status());
  host.rpc.handle('install', () => engine.install());
  host.rpc.handle('probe', (x) => engine.probe(String(obj(x).path ?? '')));
  host.rpc.handle('pickFiles', () => host.files.pick({ multiple: true, extensions: MEDIA, title: 'Файлы для конвертации' }));
  host.rpc.handle('pickFolder', async () => (await host.files.pick({ folder: true, title: 'Куда сохранять результаты' }))[0] ?? null);
  host.rpc.handle('start', (x) => engine.start(obj(x).items as Item[], obj(x).out as { mode: 'next' | 'folder'; folder?: string } | undefined));
  host.rpc.handle('cancel', (x) => engine.cancel(String(obj(x).id ?? '')));
  host.rpc.handle('list', () => engine.list());
  host.rpc.handle('reveal', (x) => host.files.reveal(String(obj(x).path ?? '')));
  host.rpc.handle('open', (x) => host.files.open(String(obj(x).path ?? '')));
  host.rpc.handle('settings', () => engine.settings());
  host.rpc.handle('setSettings', (x) => engine.setSettings(obj(x) as { mode?: 'next' | 'folder'; folder?: string }));
  host.lifecycle.onStop(() => engine.stop());
}

/** The person's files through the program: results are named «имя (Quadro).ext». */
export function engineFiles(host: Pick<PartHostApi, 'files'>): EngineFiles {
  return {
    stat: (path) => host.files.stat(path),
    outputPath: (path, ext, folder) => host.files.outputPath(path, ext, { suffix: 'Quadro', ...(folder ? { folder } : {}) }),
    remove: (path) => host.files.remove(path),
  };
}

async function main(): Promise<void> {
  const host = await connect();
  const engine = new ConvertEngine({
    dataDir: host.app.dataDir,
    bin: join(host.app.download(FFMPEG.download, { unpacked: true }), ...FFMPEG.bin.split('/')),
    version: FFMPEG.version,
    files: engineFiles(host),
    spawn: (cmd, args) => host.processes.spawn(cmd, args, { windowsHide: true }),
    emit: (name, data) => host.events.emit(name, data),
    busy: (reason) => host.lifecycle.busy(reason),
  });
  serveConvert(host, engine);
}

// Started by the program (an installed app's part talks over Node's IPC channel); imported by tests — nothing runs.
if (typeof process.send === 'function' || (process as unknown as { parentPort?: unknown }).parentPort) void main();
