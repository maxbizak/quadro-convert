import { describe, expect, it } from 'vitest';
import { BUDGET_MS, chatCompress, JobWaiter, objectAction, objectFile, sizeText, targetOf, type ActionDeps } from '../pc/actions';
import type { Item, Job } from '../pc/engine';

// The actions over a video of Hub (shell.objectAction@1, run «pc») and «/compress» in personal messages: what the part asks the
// engine, and what it answers the shell within the program's 60 s.

const MB = 1024 * 1024;
const FILE = 'C:\\Users\\me\\Downloads\\Quadro Hub\\clip.mp4';
const fileObject = (path = FILE) => ({ kind: 'file', id: '/api/files/1', title: 'clip.mp4', facts: { ext: 'mp4' }, url: '/api/files/1', path });

function fakeDeps(outcome: Partial<Job> | null, picked: string[] = []) {
  const started: Item[] = [];
  let clock = 0;
  const waited: number[] = [];
  const deps: ActionDeps = {
    start: async (items) => {
      started.push(...items);
      return { ids: ['job-1'] };
    },
    finished: async (_id, ms) => {
      waited.push(ms);
      return outcome ? ({ id: 'job-1', path: started[0]!.path, op: started[0]!.op, progress: 1, state: 'done', ...outcome } as Job) : null;
    },
    pick: async () => {
      clock += 15_000; // the person looked for the file in Windows' window
      return picked;
    },
    now: () => clock,
  };
  return { deps, started, waited };
}

describe('actions over a video of Hub', () => {
  it('«Убрать звук» — the file the program gave, without sound, next to it', async () => {
    const { deps, started } = fakeDeps({ outPath: 'C:\\Users\\me\\Downloads\\Quadro Hub\\clip (Quadro).mp4', outSize: 3 * MB });
    const answer = await objectAction(deps, 'actMute', { object: fileObject(), values: {} });
    expect(started).toEqual([{ path: FILE, op: 'removeAudio', params: {} }]);
    expect(answer.message).toBe('Готово «clip (Quadro).mp4»: 3 МБ — в папке «Quadro Hub»');
  });

  it('«Сжать…» takes the size of Hub\'s form and says what it became', async () => {
    const { deps, started } = fakeDeps({ outPath: 'D:\\v\\clip (Quadro).mp4', inSize: 31 * MB, outSize: 9.6 * MB });
    const answer = await objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 10 } });
    expect(started[0]).toEqual({ path: FILE, op: 'compress', params: { mode: 'size', targetMB: 10 } });
    expect(answer.message).toBe('Готово «clip (Quadro).mp4»: 9,6 МБ, было 31 МБ — в папке «v»');
  });

  it('«Вытащить звук в mp3»', async () => {
    const { deps, started } = fakeDeps({ outPath: 'D:\\v\\clip (Quadro).mp3', outSize: 900 * 1024 });
    expect((await objectAction(deps, 'actAudio', { object: fileObject(), values: {} })).message).toBe('Готово «clip (Quadro).mp3»: 900 КБ — в папке «v»');
    expect(started[0]).toEqual({ path: FILE, op: 'extractAudio', params: { to: 'mp3' } });
  });

  it('a long job answers at once and goes on: the result is in «Готовое»', async () => {
    const { deps, waited } = fakeDeps(null);
    expect((await objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 25 } })).message).toBe(
      'Сжимаю «clip.mp4» — готовый файл будет во вкладке «Готовое» Конвертера',
    );
    expect(waited).toEqual([BUDGET_MS]);
  });

  it('a failed job is the error the person sees; a cancelled one says so', async () => {
    await expect(objectAction(fakeDeps({ state: 'failed', error: 'Файл уже сжат, меньше не получится' }).deps, 'actCompress', { object: fileObject(), values: { targetMB: 10 } })).rejects.toThrow('Файл уже сжат');
    expect((await objectAction(fakeDeps({ state: 'cancelled' }).deps, 'actMute', { object: fileObject(), values: {} })).message).toBe('Отменено');
  });

  it('refuses what is not a video file with a path, a size outside the form, and methods it does not have', async () => {
    const { deps, started } = fakeDeps({});
    await expect(objectAction(deps, 'actMute', { object: { kind: 'person', id: 'u1', title: 'Аня' }, values: {} })).rejects.toThrow('с файлом');
    await expect(objectAction(deps, 'actMute', { object: { ...fileObject(), path: undefined }, values: {} })).rejects.toThrow('с файлом');
    await expect(objectAction(deps, 'actMute', { object: fileObject('C:\\x\\song.mp3'), values: {} })).rejects.toThrow('для видео');
    await expect(objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 0 } })).rejects.toThrow('от 1 до 4000 МБ');
    await expect(objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 'много' } })).rejects.toThrow('от 1 до 4000 МБ');
    await expect(objectAction(deps, 'actDelete', { object: fileObject(), values: {} })).rejects.toThrow('Нет такого действия');
    await expect(objectAction(deps, 'actMute', null)).rejects.toThrow('с файлом');
    expect(started).toEqual([]);
  });
});

describe('«/compress» in personal messages', () => {
  it('the person picks a video; the reply is a notice of the chat, the wait counts the time in Windows\' window', async () => {
    const { deps, started, waited } = fakeDeps({ outPath: 'C:\\v\\trip (Quadro).mp4', inSize: 40 * MB, outSize: 9.8 * MB }, ['C:\\v\\trip.mp4']);
    const answer = await chatCompress(deps, { command: 'compress', values: { targetMB: 10 }, where: { kind: 'dm', conversationId: 'c1' } });
    expect(started[0]).toEqual({ path: 'C:\\v\\trip.mp4', op: 'compress', params: { mode: 'size', targetMB: 10 } });
    expect(waited).toEqual([BUDGET_MS - 15_000]);
    expect(answer).toEqual({ type: 'reply', body: 'Готово «trip (Quadro).mp4»: 9,8 МБ, было 40 МБ — в папке «v». Перетащите файл в беседу' });
  });

  it('Windows\' window closed without a file — nothing is said', async () => {
    const { deps, started } = fakeDeps({}, []);
    expect(await chatCompress(deps, { values: { targetMB: 10 } })).toEqual({ type: 'ack' });
    expect(started).toEqual([]);
  });

  it('a long one — «Сжимаю…», without the hint to drag a file that is not there yet', async () => {
    const { deps } = fakeDeps(null, ['C:\\v\\trip.mp4']);
    expect(await chatCompress(deps, { values: {} })).toEqual({ type: 'reply', body: 'Сжимаю «trip.mp4» — готовый файл будет во вкладке «Готовое» Конвертера' });
  });
});

describe('helpers', () => {
  it('objectFile keeps only a file with a path; targetOf defaults to 10 МБ', () => {
    expect(objectFile({ object: fileObject(), values: { targetMB: 5 } })).toEqual({ path: FILE, title: 'clip.mp4', values: { targetMB: 5 } });
    expect(targetOf({})).toBe(10);
    expect(sizeText(512)).toBe('1 КБ');
    expect(sizeText(250 * MB)).toBe('250 МБ');
  });

  it('JobWaiter: the end of a job, a job already over, and the time running out', async () => {
    const waiter = new JobWaiter();
    const job = (state: Job['state']): Job => ({ id: 'j', path: FILE, op: 'compress', state, progress: 0 });
    const waiting = waiter.finished('j', 1_000);
    waiter.seen(job('running'));
    waiter.seen(job('done'));
    expect((await waiting)?.state).toBe('done');
    expect((await waiter.finished('j', 1_000, job('failed')))?.state).toBe('failed');
    expect(await waiter.finished('k', 5)).toBeNull();
  });
});
