import { basename, dirname } from 'node:path';
import type { Item, Job, Op } from './engine';

// What «Конвертер» does from outside its screen (Hub's API, docs/v2/kernel.md §12ж and chat-apps.md §2):
//  - actions over a video of Hub (shell.objectAction@1, run «pc»): the program downloads the file to «Загрузки\Quadro Hub» and
//    gives it to the part as picked by the person — `{ object: { kind: 'file', title, path }, values }`;
//  - «/compress» in personal messages (servers.command@1, handler «pc:»): the person picks the video in Windows' own window.
// The program waits for a call at most 60 s, so the part answers within BUDGET_MS: the result if it is ready, or «сжимаю…» — the
// job goes on and its result appears in «Готовое» (the screen hears its events).

/** Videos it acts on: the manifest's `match.ext` of the actions and what «/compress» lets the person pick. */
export const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'wmv'] as const;
/** Sounds «Открыть с помощью» brings to its screen (with the videos). */
export const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac', 'wma'] as const;

/** How long a call waits for the job (the program's limit is 60 s; the part may be starting and Windows' window takes time). */
export const BUDGET_MS = 40_000;

/** The target size of «Сжать…» and «/compress» (МБ): Discord without Nitro — 10, Telegram — 2000 (its limit 2 ГБ). */
export const TARGET_MB = { default: 10, min: 1, max: 4000 } as const;

export interface ActionDeps {
  start(items: Item[]): Promise<{ ids: string[] }>;
  /** The job's end (done, failed, cancelled), or null when `ms` passed first. */
  finished(id: string, ms: number): Promise<Job | null>;
  pick(): Promise<string[]>;
  now(): number;
}

type Values = Record<string, unknown>;

/** The file of Hub the program gave with an action: its path (only a file, only with a path — anything else is refused). */
export function objectFile(params: unknown): { path: string; title: string; values: Values } {
  const p = params && typeof params === 'object' ? (params as { object?: unknown; values?: unknown }) : {};
  const o = p.object && typeof p.object === 'object' ? (p.object as { kind?: unknown; path?: unknown; title?: unknown }) : {};
  if (o.kind !== 'file' || typeof o.path !== 'string' || !o.path) throw new Error('Это действие работает с файлом в программе Quadro Hub');
  const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? (p.values as Values) : {};
  return { path: o.path, title: typeof o.title === 'string' && o.title ? o.title : basename(o.path), values };
}

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

const WORK: Record<'removeAudio' | 'compress' | 'extractAudio', string> = { removeAudio: 'Убираю звук', compress: 'Сжимаю', extractAudio: 'Вынимаю звук' };

/** Starts one job and waits for it within the budget: the line for the person, or the job's own error. */
export async function runOne(deps: ActionDeps, item: Item & { op: keyof typeof WORK }, title: string, since: number): Promise<string> {
  const { ids } = await deps.start([item]);
  const id = ids[0]!;
  const job = await deps.finished(id, Math.max(0, BUDGET_MS - (deps.now() - since)));
  if (!job) return `${WORK[item.op]} «${title}» — готовый файл будет во вкладке «Готовое» Конвертера`;
  if (job.state === 'cancelled') return 'Отменено';
  if (job.state === 'failed') throw new Error(job.error || 'Не удалось обработать файл');
  const name = job.outPath ? basename(job.outPath) : title;
  const where = job.outPath ? ` — в папке «${basename(dirname(job.outPath))}»` : '';
  const sizes = item.op === 'compress' && job.inSize && job.outSize ? `: ${sizeText(job.outSize)}, было ${sizeText(job.inSize)}` : job.outSize ? `: ${sizeText(job.outSize)}` : '';
  return `Готово «${name}»${sizes}${where}`;
}

/** The actions of the manifest (`run.method`) → the engine's operation. */
export const OBJECT_ACTIONS: Record<string, (values: Values) => { op: Op & keyof typeof WORK; params: Record<string, unknown> }> = {
  actMute: () => ({ op: 'removeAudio', params: {} }),
  actCompress: (values) => ({ op: 'compress', params: { mode: 'size', targetMB: targetOf(values) } }),
  actAudio: () => ({ op: 'extractAudio', params: { to: 'mp3' } }),
};

/** An action over a file of Hub: `{ message }` — the shell's line for the person («Готово …» or «Сжимаю …»). */
export async function objectAction(deps: ActionDeps, method: string, params: unknown): Promise<{ message: string }> {
  const since = deps.now();
  const make = OBJECT_ACTIONS[method];
  if (!make) throw new Error('Нет такого действия');
  const { path, title, values } = objectFile(params);
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (!(VIDEO_EXT as readonly string[]).includes(ext)) throw new Error('Это действие — для видео');
  const { op, params: p } = make(values);
  return { message: await runOne(deps, { path, op, params: p }, title, since) };
}

/**
 * «/compress» in a personal conversation: the person picks the video (Windows' window), it is compressed next to the original.
 * The answer is the chat's `{ type: 'reply', body }` (a notice for the person — apps have no messages in personal conversations yet);
 * the window closed without a file — `{ type: 'ack' }`, nothing is shown.
 */
export async function chatCompress(deps: ActionDeps, params: unknown): Promise<{ type: 'reply'; body: string } | { type: 'ack' }> {
  const since = deps.now();
  const p = params && typeof params === 'object' ? (params as { values?: unknown }) : {};
  const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? (p.values as Values) : {};
  const targetMB = targetOf(values);
  const [path] = await deps.pick();
  if (!path) return { type: 'ack' };
  const body = await runOne(deps, { path, op: 'compress', params: { mode: 'size', targetMB } }, basename(path), since);
  return { type: 'reply', body: body.startsWith('Готово') ? `${body}. Перетащите файл в беседу` : body };
}

/** Waits for jobs by the engine's own events («job»): what `finished` of ActionDeps needs. */
export class JobWaiter {
  private readonly waiting = new Map<string, Set<(job: Job) => void>>();
  /** Every event of the engine goes here too. */
  seen(job: Job): void {
    if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') return;
    const set = this.waiting.get(job.id);
    this.waiting.delete(job.id);
    set?.forEach((fn) => fn(job));
  }
  finished(id: string, ms: number, current?: Job): Promise<Job | null> {
    if (current && (current.state === 'done' || current.state === 'failed' || current.state === 'cancelled')) return Promise.resolve(current);
    return new Promise((resolve) => {
      const set = this.waiting.get(id) ?? new Set<(job: Job) => void>();
      const done = (job: Job) => {
        clearTimeout(timer);
        resolve(job);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        if (!set.size) this.waiting.delete(id);
        resolve(null);
      }, ms);
      set.add(done);
      this.waiting.set(id, set);
    });
  }
}
