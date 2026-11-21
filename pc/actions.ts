import { basename, dirname } from 'node:path';
import type { Item, Job, Op } from './engine';

// What «Конвертер» does from outside its screen (Hub's API, docs/v2/kernel.md §12ж and chat-apps.md §2):
//  - actions over a video or a sound of Hub (shell.objectAction@1, run «pc», `match.mime` «video/*» / «audio/*»): the program downloads
//    the file to «Загрузки\Quadro Hub» and gives it to the part as picked by the person — `{ object: { kind: 'file', title, facts, path }, values }`;
//  - «/сжать» in personal messages (servers.command@1, handler «pc:»): the person picks the video in Windows' own window.
// The program waits for a call at most 60 s, so the part answers at once `{ pending: jobId, message }` and tells the rest by its
// events with that jobId: `job.progress { percent, message }`, then `job.done { message, kind }` or `job.failed { message }` —
// Hub keeps the notice with the percent until the end (JobEvents). The end of «/сжать» carries the result itself: the part sends
// it to Hub as the person's file (host.files.upload, pc-host.md §6.20) and `job.done` gets `files: [{ fileId, width?, height? }]` —
// Hub puts the line and the file into the person's conversation with «Конвертер».

/** Videos «/сжать» lets the person pick and «Открыть с помощью» brings (the actions take the same). */
export const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv'] as const;
/** Sounds «Открыть с помощью» brings to its screen (with the videos). */
export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'wma'] as const;

/** The target size of «Сжать…» and «/сжать» (МБ): Discord without Nitro — 10, Telegram — 2000 (its limit 2 ГБ). */
export const TARGET_MB = { default: 10, min: 1, max: 4000 } as const;

type Work = 'removeAudio' | 'compress' | 'extractAudio' | 'convert';
const WORK: Record<Work, string> = { removeAudio: 'Убираю звук', compress: 'Сжимаю', extractAudio: 'Вынимаю звук', convert: 'Перевожу в mp3' };

/** A job started from outside the screen: what to say about it, and what to add to its last line. */
export interface Followed {
  op: Work;
  title: string;
  /** Said after «Готово …». */
  tail?: string;
  /** The result goes to the person's conversation with the app as a file (pc.files.upload); a program without it — the hint to drag it. */
  upload?: boolean;
}

/** The program sends a result to Hub as the person's file; ffprobe tells its picture's size (Hub shows the video at once). */
export interface Uploader {
  upload(path: string): Promise<{ fileId: string }>;
  measure?(path: string): Promise<{ width?: number; height?: number }>;
}

/** The end of «/сжать» when the file cannot go by itself (a program before files.upload). */
export const DRAG_TAIL = '. Перетащите файл в беседу';
/** A program that has no such call answers so (a program before 1.0.106). */
const NO_CALL = /Нет такого действия/i;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 200) || 'ошибка';

export interface ActionDeps {
  start(items: Item[]): Promise<{ ids: string[] }>;
  pick(): Promise<string[]>;
  /** The job now (it may already be over when it is followed). */
  current(id: string): Job | undefined;
  events: JobEvents;
}

type Values = Record<string, unknown>;

/** The file of Hub the program gave with an action: its path (only a file, only with a path — anything else is refused) and mime. */
export function objectFile(params: unknown): { path: string; title: string; mime: string; values: Values } {
  const p = params && typeof params === 'object' ? (params as { object?: unknown; values?: unknown }) : {};
  const o = p.object && typeof p.object === 'object' ? (p.object as { kind?: unknown; path?: unknown; title?: unknown; facts?: unknown }) : {};
  if (o.kind !== 'file' || typeof o.path !== 'string' || !o.path) throw new Error('Это действие работает с файлом в программе Quadro Hub');
  const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? (p.values as Values) : {};
  const facts = o.facts && typeof o.facts === 'object' ? (o.facts as { mime?: unknown }) : {};
  const mime = typeof facts.mime === 'string' ? facts.mime.toLowerCase() : '';
  return { path: o.path, title: typeof o.title === 'string' && o.title ? o.title : basename(o.path), mime, values };
}

/** Already mp3: by its mime (Hub's fact), else by the name of the downloaded file. */
const isMp3 = (mime: string, path: string) => mime === 'audio/mpeg' || mime === 'audio/mp3' || /\.mp3$/i.test(path);

/** The size asked in the form (Hub checked it against the manifest; the part checks again). */
export function targetOf(values: Values): number {
  const mb = Number(values.targetMB ?? TARGET_MB.default);
  if (!Number.isFinite(mb) || mb < TARGET_MB.min || mb > TARGET_MB.max) throw new Error(`Размер — от ${TARGET_MB.min} до ${TARGET_MB.max} МБ`);
  return mb;
}

export function sizeText(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toLocaleString('ru-RU', { maximumFractionDigits: mb >= 100 ? 0 : 1 })} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** «Готово «клип (Quadro).mp4»: 5 МБ, было 17,9 МБ — в папке «Quadro Hub»». */
export function doneLine(job: Job, f: Followed): string {
  const name = job.outPath ? basename(job.outPath) : f.title;
  const where = job.outPath ? ` — в папке «${basename(dirname(job.outPath))}»` : '';
  const sizes = f.op === 'compress' && job.inSize && job.outSize ? `: ${sizeText(job.outSize)}, было ${sizeText(job.inSize)}` : job.outSize ? `: ${sizeText(job.outSize)}` : '';
  return `Готово «${name}»${sizes}${where}${f.tail ?? ''}`;
}

/** The first line of a job: «Сжимаю «клип.mp4»». */
export const workLine = (f: Followed) => `${WORK[f.op]} «${f.title}»`;

/**
 * The part's events `job.*` for the jobs started by an action or a command (Hub follows them by jobId): the engine's own events
 * («job», for the screen) come here too. The percent is told when its whole number changes.
 */
export class JobEvents {
  private readonly followed = new Map<string, Followed & { percent: number }>();
  constructor(
    private readonly emit: (name: 'job.progress' | 'job.done' | 'job.failed', data: Record<string, unknown>) => void,
    private readonly uploader?: Uploader,
  ) {}

  follow(id: string, f: Followed, now?: Job): void {
    this.followed.set(id, { ...f, percent: -1 });
    if (now) this.seen(now);
  }

  seen(job: Job): void {
    const f = this.followed.get(job.id);
    if (!f) return;
    if (job.state === 'queued' || job.state === 'running') {
      const percent = Math.max(0, Math.min(99, Math.floor((job.progress || 0) * 100)));
      if (percent === f.percent) return;
      f.percent = percent;
      this.emit('job.progress', { jobId: job.id, percent, message: workLine(f) });
      return;
    }
    this.followed.delete(job.id);
    if (job.state !== 'done') {
      this.emit('job.failed', { jobId: job.id, message: job.state === 'cancelled' ? 'Отменено' : job.error || 'Не удалось обработать файл' });
      return;
    }
    if (f.upload) void this.sendResult(job, f);
    else this.emit('job.done', { jobId: job.id, message: doneLine(job, f), kind: 'success' });
  }

  /**
   * The result to the person's conversation: uploaded first (Hub's notice says so at 99 %), then `job.done` with its file. A program
   * without files.upload — the line with the hint to drag it; the upload failed — the line says why (the file stays in its folder).
   */
  private async sendResult(job: Job, f: Followed): Promise<void> {
    const done = (tail: string, files?: Array<Record<string, unknown>>) =>
      this.emit('job.done', { jobId: job.id, message: doneLine(job, { ...f, tail: `${f.tail ?? ''}${tail}` }), kind: 'success', ...(files ? { files } : {}) });
    const path = job.outPath;
    if (!this.uploader || !path) return done(DRAG_TAIL);
    this.emit('job.progress', { jobId: job.id, percent: 99, message: `Отправляю «${basename(path)}» в беседу` });
    try {
      const [file, size] = await Promise.all([this.uploader.upload(path), this.uploader.measure ? this.uploader.measure(path).catch(() => ({})) : Promise.resolve({})]);
      const { width, height } = size as { width?: unknown; height?: unknown };
      const picture = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? { width, height } : {};
      done('', [{ fileId: file.fileId, ...picture }]);
    } catch (e) {
      const why = errorText(e);
      done(NO_CALL.test(why) ? DRAG_TAIL : `. Файл не отправился: ${why}`);
    }
  }
}

/** Starts one job, follows it, and answers at once: `{ pending, message }` (Hub keeps the notice until `job.done` / `job.failed`). */
async function startFollowed(deps: ActionDeps, item: Item & { op: Work }, f: Followed, message = `${workLine(f)}…`): Promise<{ pending: string; message: string }> {
  const { ids } = await deps.start([item]);
  const id = ids[0]!;
  deps.events.follow(id, f, deps.current(id));
  return { pending: id, message };
}

/** The actions of the manifest (`run.method`) → the engine's operation. */
export const OBJECT_ACTIONS: Record<string, (values: Values) => { op: Op & Work; params: Record<string, unknown> }> = {
  actMute: () => ({ op: 'removeAudio', params: {} }),
  actCompress: (values) => ({ op: 'compress', params: { mode: 'size', targetMB: targetOf(values) } }),
  actAudio: () => ({ op: 'extractAudio', params: { to: 'mp3' } }),
  actToMp3: () => ({ op: 'convert', params: { to: 'mp3' } }),
};

/** An action over a file of Hub: `{ pending, message }` — the rest comes as the part's events `job.*`; nothing to do — `{ message, kind: 'info' }`. */
export async function objectAction(deps: ActionDeps, method: string, params: unknown): Promise<{ pending: string; message: string } | { message: string; kind: 'info' }> {
  const make = OBJECT_ACTIONS[method];
  if (!make) throw new Error('Нет такого действия');
  const { path, title, mime, values } = objectFile(params);
  // «audio/*» takes an mp3 too (Hub's match has no «but»): it stays as it is.
  if (method === 'actToMp3' && isMp3(mime, path)) return { message: `«${title}» уже в mp3`, kind: 'info' };
  const { op, params: p } = make(values);
  return startFollowed(deps, { path, op, params: p }, { op, title });
}

/**
 * «/сжать» in a personal conversation: the person picks the video (Windows' window), it is compressed next to the original.
 * The answer is Hub's `{ pending, message }`, its end comes as `job.done` with the result uploaded as the person's file. The window closed without a file — `{ type: 'ack' }`,
 * nothing is shown.
 */
export async function chatCompress(deps: ActionDeps, params: unknown): Promise<{ pending: string; message: string } | { type: 'ack' }> {
  const p = params && typeof params === 'object' ? (params as { values?: unknown }) : {};
  const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? (p.values as Values) : {};
  const targetMB = targetOf(values);
  const [path] = await deps.pick();
  if (!path) return { type: 'ack' };
  const title = basename(path);
  return startFollowed(deps, { path, op: 'compress', params: { mode: 'size', targetMB } }, { op: 'compress', title, upload: true }, `Сжимаю «${title}» до ${targetMB} МБ…`);
}
