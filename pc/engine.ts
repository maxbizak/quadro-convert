import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, extname, join, parse } from 'node:path';
import type { ChildProcess } from 'node:child_process';

export type Kind = 'video' | 'audio' | 'image';
export type Op = 'convert' | 'compress' | 'trim' | 'removeAudio' | 'extractAudio' | 'gif' | 'rotate' | 'resize';
export interface Probe { kind: Kind; format: string; sizeBytes: number; durationSec?: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean; codecs: string[] }
export interface Item { path: string; op: Op; params: Record<string, unknown> }
export interface Job { id: string; path: string; op: Op; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; etaSec?: number; outPath?: string; outSize?: number; inSize?: number; error?: string }
export interface Pin { version: string; url: string; sha256: string; size: number }
/** What the part's engine gets from its host (@quadrohub/pc-sdk): its folders, its FFmpeg, the person's files through the program. */
export interface EngineFiles {
  stat(path: string): Promise<{ exists: boolean; isFile: boolean; size: number }>;
  /** A free reserved name for a result next to a picked file (or in a picked folder). */
  outputPath(path: string, ext: string, folder?: string): Promise<string>;
  /** Only a result the program named. */
  remove(path: string): Promise<void>;
}
export interface EngineDeps { dataDir: string; bin: string; version?: string; files: EngineFiles; spawn: (cmd: string, args: string[]) => ChildProcess; emit: (name: 'job', data: unknown) => void; busy: (reason: string | null) => void }
const VIDEO = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'wma']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'tif', 'gif', 'ico']);
const OUTPUT_VIDEO = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v']);
const OUTPUT_AUDIO = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac']);
const OUTPUT_IMAGE = new Set(['jpg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico']);
const ext = (path: string) => extname(path).slice(1).toLowerCase();
const num = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
const text = (v: unknown) => typeof v === 'string' ? v.toLowerCase().replace(/^\./, '') : '';
const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
/**
 * Windows' own tar (bsdtar, Windows 10 1803+), by its full path: «tar.exe» by name may be GNU tar of Git or MSYS first on PATH,
 * which takes «C:» of a path for a remote host («Cannot connect to C: resolve failed», 19.11 check).
 */
export function windowsTar(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe');
}
export function shaMatches(bytes: Buffer, sha: string): boolean { return /^[0-9a-f]{64}$/i.test(sha) && createHash('sha256').update(bytes).digest('hex') === sha.toLowerCase(); }
export function resultPath(input: string, to: string, folder = dirname(input), exists = existsSync): string {
  const name = parse(input).name;
  let path = join(folder, `${name} (Quadro).${to}`);
  for (let n = 2; exists(path); n++) path = join(folder, `${name} (Quadro) (${n}).${to}`);
  return path;
}
export function progressOf(line: string, durationSec: number): number | null {
  const m = /^(?:out_time_ms|out_time_us)=(\d+)/m.exec(line);
  if (m && durationSec > 0) return Math.min(0.99, Number(m[1]) / 1_000_000 / durationSec);
  const t = /^out_time=(\d+):(\d+):([\d.]+)/m.exec(line);
  return t && durationSec > 0 ? Math.min(0.99, (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) / durationSec) : null;
}
export function oversized(input: number, output: number): boolean { return output >= input; }
export function outputFormat(item: Item, info: Probe): string {
  const p = item.params ?? {};
  const source = ext(item.path) === 'jpeg' ? 'jpg' : ext(item.path) === 'tif' ? 'tiff' : ext(item.path);
  switch (item.op) {
    case 'convert': case 'extractAudio': return text(p.to);
    case 'gif': return 'gif';
    case 'compress': return info.kind === 'video' ? 'mp4' : info.kind === 'audio' ? 'mp3' : source;
    case 'trim': case 'removeAudio': return ['flv', 'wmv'].includes(source) ? 'mkv' : source;
    case 'rotate': case 'resize': return info.kind === 'video' ? 'mp4' : source;
  }
}
export function ffmpegArgs(item: Item, info: Probe, output: string, pass = 0): string[] {
  const p = item.params ?? {};
  const to = outputFormat(item, info);
  const valid = info.kind === 'image' ? OUTPUT_IMAGE : info.kind === 'audio' ? OUTPUT_AUDIO : new Set([...OUTPUT_VIDEO, ...OUTPUT_AUDIO, 'gif']);
  if (!valid.has(to) || !to) throw new Error('Этот формат не поддерживается');
  if (['flv', 'wmv', 'wma'].includes(to)) throw new Error('Этот формат доступен только для чтения');
  if ((item.op === 'removeAudio' || item.op === 'gif' || item.op === 'rotate' || item.op === 'resize' && info.kind === 'video') && !info.hasVideo) throw new Error('В файле нет видео');
  if (item.op === 'extractAudio' && !info.hasAudio) throw new Error('В файле нет звука');
  if (item.op === 'trim' && info.kind === 'image') throw new Error('Изображение нельзя обрезать по времени');
  const a = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-loglevel', 'error'];
  const input = ['-i', item.path];
  const outputArgs: string[] = [];
  if (item.op === 'trim') {
    const start = num(p.start, 0, 0, 864000);
    const end = num(p.end, info.durationSec ?? 864000, start + 0.001, 864000);
    if (end <= start) throw new Error('Конец обрезки должен быть позже начала');
    a.push('-ss', String(start)); input.push('-to', String(end - start));
    if (!p.exact) outputArgs.push('-c', 'copy');
  }
  if (item.op === 'removeAudio') outputArgs.push('-an', '-c:v', 'copy');
  if (item.op === 'extractAudio') outputArgs.push('-vn');
  if (item.op === 'gif' || to === 'gif' && info.kind === 'video') {
    const start = num(p.start, 0, 0, 864000);
    const end = num(p.end, info.durationSec ?? 864000, start + 0.001, 864000);
    if (start) a.push('-ss', String(start));
    if (end < (info.durationSec ?? Infinity)) input.push('-t', String(end - start));
    const fps = num(p.fps, 12, 1, 30);
    const width = even(num(p.width, 480, 32, 1920));
    outputArgs.push('-filter_complex', `[0:v]fps=${fps},scale=${width}:-1:flags=lanczos,split[v0][v1];[v0]palettegen[p];[v1][p]paletteuse[v]`, '-map', '[v]', '-an');
  } else if (item.op === 'rotate') {
    const deg = num(p.deg, 90, -270, 270);
    const filter = deg === 90 ? 'transpose=1' : deg === 270 || deg === -90 ? 'transpose=2' : deg === 180 || deg === -180 ? 'hflip,vflip' : '';
    if (!filter) throw new Error('Поворот: только 90, 180 или 270 градусов');
    outputArgs.push('-vf', filter);
  } else if (item.op === 'resize') {
    const w = num(p.width, 0, 0, 16384); const h = num(p.height, 0, 0, 16384);
    if (!w && !h) throw new Error('Укажите ширину или высоту');
    outputArgs.push('-vf', `scale=${w ? even(w) : '-2'}:${h ? even(h) : '-2'}:force_original_aspect_ratio=decrease`);
  }
  if (item.op === 'compress') {
    if (info.kind === 'video') {
      if (p.mode === 'size') {
        const mb = num(p.targetMB, 0, 0.1, 100000);
        if (!mb || !info.durationSec) throw new Error('Нужны размер и длительность видео');
        const kb = Math.floor(mb * 8192 / info.durationSec - 128);
        if (kb < 50) throw new Error('Целевой размер слишком мал');
        outputArgs.push('-c:v', 'libx264', '-b:v', `${kb}k`, '-preset', 'slow', '-c:a', 'aac', '-b:a', '128k', '-pass', String(pass || 1));
      } else outputArgs.push('-c:v', 'libx264', '-crf', String(num(p.quality, 23, 16, 35)), '-preset', 'slow', '-c:a', 'aac', '-b:a', '128k');
    } else if (info.kind === 'audio') outputArgs.push(...audioCodec(to, String(num(p.quality, 128, 32, 320))));
    else {
      const width = num(p.maxWidth, 0, 0, 16384);
      if (width) outputArgs.push('-vf', `scale='min(iw,${even(width)})':-1`);
      if (to === 'jpg') outputArgs.push('-q:v', String(num(p.quality, 5, 2, 31)));
      if (to === 'webp') outputArgs.push('-quality', String(num(p.quality, 75, 1, 100)));
      if (to === 'avif') outputArgs.push('-crf', String(num(p.quality, 35, 0, 63)));
    }
  } else if (item.op === 'convert' || item.op === 'extractAudio') {
    if (OUTPUT_AUDIO.has(to) && info.kind !== 'image') {
      const codec = info.codecs.find(c => ['mp3', 'opus', 'aac', 'flac', 'pcm_s16le'].includes(c));
      const copy = item.op === 'extractAudio' && ((to === 'mp3' && codec === 'mp3') || ((to === 'opus' || to === 'ogg') && codec === 'opus') || ((to === 'm4a' || to === 'aac') && codec === 'aac') || (to === 'flac' && codec === 'flac') || (to === 'wav' && codec === 'pcm_s16le'));
      outputArgs.push(...(copy ? ['-c:a', 'copy'] : audioCodec(to, to === 'opus' ? '128' : '192')));
    }
    else if (OUTPUT_VIDEO.has(to)) {
      const compatible = (to === 'mkv' && info.format === 'matroska') || (['mp4', 'mov', 'm4v'].includes(to) && info.codecs.includes('h264') && (!info.hasAudio || info.codecs.includes('aac'))) || (to === 'webm' && info.codecs.includes('vp9') && (!info.hasAudio || info.codecs.includes('opus')));
      if (compatible && item.op === 'convert') outputArgs.push('-c', 'copy');
      else if (to === 'webm') outputArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k');
      else outputArgs.push('-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k');
    } else if (info.kind === 'image') {
      if (to === 'jpg') outputArgs.push('-q:v', '2');
      if (to === 'webp') outputArgs.push('-quality', '85');
      if (to === 'avif') outputArgs.push('-crf', '30');
      if (to === 'ico') outputArgs.push('-vf', 'scale=256:256:force_original_aspect_ratio=decrease');
    }
  } else if (item.op === 'trim' && p.exact) outputArgs.push('-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-b:a', '192k');
  else if (['rotate', 'resize'].includes(item.op) && info.kind === 'video') outputArgs.push('-c:v', 'libx264', '-crf', '20', '-c:a', 'copy');
  return [...a, ...input, ...outputArgs, output];
}
function audioCodec(to: string, kb: string): string[] {
  if (to === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', `${kb}k`];
  if (to === 'opus' || to === 'ogg') return ['-c:a', 'libopus', '-b:a', `${kb}k`];
  if (to === 'aac' || to === 'm4a') return ['-c:a', 'aac', '-b:a', `${kb}k`];
  if (to === 'flac') return ['-c:a', 'flac'];
  if (to === 'wav') return ['-c:a', 'pcm_s16le'];
  return [];
}

export class ConvertEngine {
  private jobs: Job[] = [];
  private queue: Array<{ job: Job; item: Item; folder?: string }> = [];
  private running = new Map<string, ChildProcess>();
  private active = new Set<string>();
  private videoActive = new Set<string>();
  private settingsValue: { mode: 'next' | 'folder'; folder?: string } = { mode: 'next' };
  constructor(private readonly deps: EngineDeps) {
    try { this.jobs = (JSON.parse(readFileSync(join(deps.dataDir, 'history.json'), 'utf8')) as Job[]).slice(0, 200).map((j): Job => j.state === 'running' || j.state === 'queued' ? { ...j, state: 'failed', error: 'Конвертация прервалась' } : j); } catch { /* fresh */ }
    try { this.settingsValue = JSON.parse(readFileSync(join(deps.dataDir, 'settings.json'), 'utf8')) as typeof this.settingsValue; } catch { /* defaults */ }
  }
  /** FFmpeg comes with the app from the catalog (its download, unpacked by the program): it is there, or the app needs reinstalling. */
  status(): { engine: 'missing' | 'ready'; version?: string; size: number } {
    const ready = existsSync(join(this.deps.bin, 'ffmpeg.exe')) && existsSync(join(this.deps.bin, 'ffprobe.exe'));
    return { engine: ready ? 'ready' : 'missing', version: this.deps.version, size: 0 };
  }
  /** Nothing to download here any more: the program installs FFmpeg with the app («Поставить» in the catalog). */
  install(): Promise<void> {
    return this.status().engine === 'ready' ? Promise.resolve() : Promise.reject(new Error('FFmpeg ставится вместе с Конвертером: поставьте его из Каталога заново'));
  }
  private run(cmd: string, args: string[], onData?: (s: string) => void, id?: string): Promise<{ code: number; stdout: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = this.deps.spawn(cmd, args); if (id) this.running.set(id, child);
      let out = ''; let err = '';
      child.stdout?.on('data', (b: Buffer) => { const s = b.toString(); out += s; onData?.(s); });
      child.stderr?.on('data', (b: Buffer) => { err += b.toString().slice(0, 2000); });
      child.on('error', reject);
      child.on('close', (code) => { if (id) this.running.delete(id); if (code === 0) resolvePromise({ code, stdout: out }); else reject(new Error(err.trim() || 'Не удалось обработать файл')); });
    });
  }
  /** What a picked file is (ffprobe reads it; the part itself learns only its size from the program). */
  async probe(path: string): Promise<Probe> {
    if (this.status().engine !== 'ready') throw new Error('FFmpeg не найден: поставьте Конвертер из Каталога заново');
    const stat = await this.deps.files.stat(path);
    if (!stat.exists || !stat.isFile) throw new Error('Файл не найден');
    const { stdout } = await this.run(join(this.deps.bin, 'ffprobe.exe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]);
    const raw = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
    const streams = raw.streams ?? []; const v = streams.find(s => s.codec_type === 'video'); const hasAudio = streams.some(s => s.codec_type === 'audio');
    const suffix = ext(path);
    const kind: Kind = IMAGE.has(suffix) && !(suffix === 'gif' && Number(raw.format?.duration) > 2) ? 'image' : v ? 'video' : hasAudio ? 'audio' : VIDEO.has(suffix) ? 'video' : AUDIO.has(suffix) ? 'audio' : 'image';
    return { kind, format: raw.format?.format_name?.split(',')[0] ?? suffix, sizeBytes: stat.size, durationSec: Number(raw.format?.duration) || undefined, width: v?.width, height: v?.height, hasVideo: Boolean(v), hasAudio, codecs: streams.map(s => s.codec_name ?? '').filter(Boolean) };
  }
  list(): Job[] { return this.jobs.map(j => ({ ...j })); }
  settings(): typeof this.settingsValue { return { ...this.settingsValue }; }
  /** «Сохранять в папку»: a folder the person picked (the program names results there only if it was picked for this app). */
  setSettings(x: { mode?: 'next' | 'folder'; folder?: string }): typeof this.settingsValue { if (x.mode !== 'next' && x.mode !== 'folder') throw new Error('Неверная папка вывода'); this.settingsValue = { mode: x.mode, ...(x.mode === 'folder' && x.folder ? { folder: x.folder } : {}) }; mkdirSync(this.deps.dataDir, { recursive: true }); writeFileSync(join(this.deps.dataDir, 'settings.json'), JSON.stringify(this.settingsValue)); return this.settings(); }
  async start(items: Item[], out?: { mode: 'next' | 'folder'; folder?: string }): Promise<{ ids: string[] }> {
    if (this.status().engine !== 'ready') throw new Error('FFmpeg не найден: поставьте Конвертер из Каталога заново');
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('Выберите файлы');
    if (out && out.mode !== 'next' && out.mode !== 'folder') throw new Error('Неверная папка вывода');
    const folder = out?.mode === 'folder' ? out.folder : this.settingsValue.mode === 'folder' ? this.settingsValue.folder : undefined;
    if (folder) { const f = await this.deps.files.stat(folder).catch(() => null); if (!f?.exists || f.isFile) throw new Error('Папка результата не найдена'); }
    for (const item of items) {
      if (!item || typeof item.path !== 'string') throw new Error('Файл не найден');
      const f = await this.deps.files.stat(item.path).catch(() => null);
      if (!f?.exists || !f.isFile) throw new Error('Файл не найден');
      if (!['convert', 'compress', 'trim', 'removeAudio', 'extractAudio', 'gif', 'rotate', 'resize'].includes(item.op)) throw new Error('Нет такого действия');
      if (!item.params || typeof item.params !== 'object' || Array.isArray(item.params)) throw new Error('Неверные параметры');
    }
    const ids = items.map(item => {
      const job: Job = { id: randomUUID(), path: item.path, op: item.op, state: 'queued', progress: 0 };
      this.jobs.unshift(job); this.queue.push({ job, item, folder }); this.deps.emit('job', job); return job.id;
    });
    this.persist(); this.pump(); return { ids };
  }
  cancel(id: string): void { const job = this.jobs.find(j => j.id === id); if (!job || job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return; job.state = 'cancelled'; this.queue = this.queue.filter(q => q.job.id !== id); this.running.get(id)?.kill(); this.update(job); this.pump(); }
  stop(): void { for (const id of this.active) this.cancel(id); for (const q of [...this.queue]) this.cancel(q.job.id); }
  private pump(): void {
    const limit = Math.max(1, availableParallelism());
    while (this.active.size < limit && this.queue.length) {
      const index = this.queue.findIndex(q => !VIDEO.has(ext(q.item.path)) || this.videoActive.size < 2);
      if (index < 0) break;
      const next = this.queue.splice(index, 1)[0];
      if (!next) break;
      if (next.job.state === 'queued') {
        this.active.add(next.job.id);
        if (VIDEO.has(ext(next.item.path))) this.videoActive.add(next.job.id);
        void this.execute(next);
      }
    }
    this.deps.busy(this.queue.length || this.active.size ? `Конвертирую ${this.queue.length + this.active.size} файлов` : null);
  }
  private async execute({ job, item, folder }: { job: Job; item: Item; folder?: string }): Promise<void> {
    job.state = 'running'; this.update(job);
    const drop = (path: string) => this.deps.files.remove(path).catch(() => undefined);
    try {
      const info = await this.probe(item.path); if ((job as Job).state === 'cancelled') return; job.inSize = info.sizeBytes;
      // A free name next to the file (or in the picked folder), named and reserved by the program: «имя (Quadro).ext».
      const to = outputFormat(item, info); const dest = await this.deps.files.outputPath(item.path, to, folder);
      job.outPath = dest; this.update(job);
      const args = ffmpegArgs(item, info, dest);
      const started = Date.now(); let buffer = '';
      // Two passes (a size to reach) share the bar: the first is 0–50 %, the second 50–100 % (it never went past the first's 99 %).
      const progressIn = (from: number, span: number) => (chunk: string) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''; for (const line of lines) { const raw = progressOf(line, info.durationSec ?? 0); const p = raw === null ? null : from + raw * span; if (p !== null && p > job.progress) { job.progress = p; job.etaSec = p > 0 ? Math.round((Date.now() - started) / 1000 * (1 - p) / p) : undefined; this.deps.emit('job', { ...job }); } } };
      const progress = progressIn(0, 1);
      const ffmpeg = join(this.deps.bin, 'ffmpeg.exe');
      if (item.op === 'compress' && item.params.mode === 'size' && info.kind === 'video') {
        const passlog = join(this.deps.dataDir, `pass-${job.id}`); mkdirSync(this.deps.dataDir, { recursive: true });
        try { await this.run(ffmpeg, [...args.slice(0, -1), '-passlogfile', passlog, '-f', 'null', 'NUL'], progressIn(0, 0.5), job.id); if ((job as Job).state === 'cancelled') return; buffer = ''; await this.run(ffmpeg, [...ffmpegArgs(item, info, dest, 2).slice(0, -1), '-passlogfile', passlog, dest], progressIn(0.5, 0.5), job.id); }
        finally { for (const suffix of ['-0.log', '-0.log.mbtree']) rmSync(passlog + suffix, { force: true }); }
      } else await this.run(ffmpeg, args, progress, job.id);
      if ((job as Job).state === 'cancelled') { await drop(dest); return; }
      job.outSize = (await this.deps.files.stat(dest)).size;
      if (item.op === 'compress' && oversized(info.sizeBytes, job.outSize)) { await drop(dest); job.state = 'failed'; job.error = 'Файл уже сжат, меньше не получится'; job.outPath = undefined; }
      else { job.state = 'done'; job.progress = 1; }
    } catch (e) { if (job.outPath) await drop(job.outPath); if ((job as Job).state !== 'cancelled') { job.state = 'failed'; job.error = e instanceof Error && /^[А-Яа-яЁё]/.test(e.message) ? e.message : 'Не удалось обработать файл'; job.outPath = undefined; } }
    finally { this.active.delete(job.id); this.videoActive.delete(job.id); this.update(job); this.pump(); }
  }
  private update(job: Job): void { this.deps.emit('job', { ...job }); this.persist(); }
  private persist(): void { mkdirSync(this.deps.dataDir, { recursive: true }); this.jobs = this.jobs.slice(0, 200); writeFileSync(join(this.deps.dataDir, 'history.json'), JSON.stringify(this.jobs)); }
}
