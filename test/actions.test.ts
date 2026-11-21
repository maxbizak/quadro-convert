import { describe, expect, it } from 'vitest';
import { chatCompress, doneLine, JobEvents, objectAction, objectFile, sizeText, targetOf, type ActionDeps, type Uploader } from '../pc/actions';
import type { Item, Job } from '../pc/engine';

// The actions over a video of Hub (shell.objectAction@1, run «pc») and «/сжать» in personal messages: what the part asks the
// engine, its answer at once ({ pending, message }) and its events job.* that Hub follows to the end (kernel.md §12ж).

const MB = 1024 * 1024;
const FILE = 'C:\\Users\\me\\Downloads\\Quadro Hub\\clip.mp4';
const fileObject = (path = FILE) => ({ kind: 'file', id: '/api/files/1', title: 'clip.mp4', facts: { mime: 'video/mp4' }, url: '/api/files/1', path });

function fakeDeps(picked: string[] = [], uploader?: Uploader) {
  const started: Item[] = [];
  const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];
  const events = new JobEvents((name, data) => emitted.push({ name, data }), uploader);
  const deps: ActionDeps = {
    start: async (items) => {
      started.push(...items);
      return { ids: ['job-1'] };
    },
    pick: async () => picked,
    current: () => ({ id: 'job-1', path: started[0]!.path, op: started[0]!.op, state: 'queued', progress: 0 }),
    events,
  };
  const job = (patch: Partial<Job>): Job => ({ id: 'job-1', path: started[0]!.path, op: started[0]!.op, state: 'running', progress: 0, ...patch });
  return { deps, started, emitted, events, job };
}

describe('actions over a video of Hub', () => {
  it('«Убрать звук» answers at once and tells the rest by job.* events with its jobId', async () => {
    const { deps, started, emitted, events, job } = fakeDeps();
    expect(await objectAction(deps, 'actMute', { object: fileObject(), values: {} })).toEqual({ pending: 'job-1', message: 'Убираю звук «clip.mp4»…' });
    expect(started).toEqual([{ path: FILE, op: 'removeAudio', params: {} }]);
    events.seen(job({ progress: 0.421 }));
    events.seen(job({ progress: 0.425 })); // the same whole percent — not told again
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\Users\\me\\Downloads\\Quadro Hub\\clip (Quadro).mp4', outSize: 3 * MB }));
    events.seen(job({ state: 'done', progress: 1 })); // after the end — nothing
    expect(emitted).toEqual([
      { name: 'job.progress', data: { jobId: 'job-1', percent: 0, message: 'Убираю звук «clip.mp4»' } },
      { name: 'job.progress', data: { jobId: 'job-1', percent: 42, message: 'Убираю звук «clip.mp4»' } },
      { name: 'job.done', data: { jobId: 'job-1', message: 'Готово «clip (Quadro).mp4»: 3 МБ — в папке «Quadro Hub»', kind: 'success' } },
    ]);
  });

  it('«Сжать…» takes the size of Hub\'s form; its end says what it became', async () => {
    const { deps, started, emitted, events, job } = fakeDeps();
    expect((await objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 10 } })).message).toBe('Сжимаю «clip.mp4»…');
    expect(started[0]).toEqual({ path: FILE, op: 'compress', params: { mode: 'size', targetMB: 10 } });
    events.seen(job({ state: 'done', progress: 1, outPath: 'D:\\v\\clip (Quadro).mp4', inSize: 31 * MB, outSize: 9.6 * MB }));
    expect(emitted.at(-1)).toEqual({ name: 'job.done', data: { jobId: 'job-1', message: 'Готово «clip (Quadro).mp4»: 9,6 МБ, было 31 МБ — в папке «v»', kind: 'success' } });
  });

  it('«Вытащить звук в mp3»; a failed job and a cancelled one end with job.failed', async () => {
    const a = fakeDeps();
    await objectAction(a.deps, 'actAudio', { object: fileObject(), values: {} });
    expect(a.started[0]).toEqual({ path: FILE, op: 'extractAudio', params: { to: 'mp3' } });
    a.events.seen(a.job({ state: 'failed', error: 'В файле нет звука' }));
    expect(a.emitted.at(-1)).toEqual({ name: 'job.failed', data: { jobId: 'job-1', message: 'В файле нет звука' } });
    const b = fakeDeps();
    await objectAction(b.deps, 'actMute', { object: fileObject(), values: {} });
    b.events.seen(b.job({ state: 'cancelled' }));
    expect(b.emitted.at(-1)).toEqual({ name: 'job.failed', data: { jobId: 'job-1', message: 'Отменено' } });
  });

  it('«Перевести в mp3» for a sound; an mp3 (by its mime or name) stays as it is', async () => {
    const { deps, started, emitted, events, job } = fakeDeps();
    const wav = { ...fileObject('C:\\d\\voice.wav'), title: 'voice.wav', facts: { mime: 'audio/wav' } };
    expect(await objectAction(deps, 'actToMp3', { object: wav, values: {} })).toEqual({ pending: 'job-1', message: 'Перевожу в mp3 «voice.wav»…' });
    expect(started).toEqual([{ path: 'C:\\d\\voice.wav', op: 'convert', params: { to: 'mp3' } }]);
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\d\\voice (Quadro).mp3', outSize: 2 * MB }));
    expect(emitted.at(-1)!.data.message).toBe('Готово «voice (Quadro).mp3»: 2 МБ — в папке «d»');
    const other = fakeDeps();
    const mp3 = { ...fileObject('C:\\d\\song.mp3'), title: 'song.mp3', facts: { mime: 'audio/mpeg' } };
    expect(await objectAction(other.deps, 'actToMp3', { object: mp3, values: {} })).toEqual({ message: '«song.mp3» уже в mp3', kind: 'info' });
    expect(await objectAction(other.deps, 'actToMp3', { object: { ...mp3, facts: {} }, values: {} })).toEqual({ message: '«song.mp3» уже в mp3', kind: 'info' });
    expect(other.started).toEqual([]);
  });

  it('a job already over when followed is told at once', () => {
    const emitted: string[] = [];
    const events = new JobEvents((name) => emitted.push(name));
    events.follow('j', { op: 'compress', title: 'a.mp4' }, { id: 'j', path: 'a.mp4', op: 'compress', state: 'done', progress: 1 });
    expect(emitted).toEqual(['job.done']);
  });

  it('jobs of the screen (not followed) give no job.* events', () => {
    const emitted: string[] = [];
    new JobEvents((name) => emitted.push(name)).seen({ id: 'x', path: 'a.mp4', op: 'convert', state: 'done', progress: 1 });
    expect(emitted).toEqual([]);
  });

  it('refuses what is not a file with a path, a size outside the form, and methods it does not have', async () => {
    const { deps, started } = fakeDeps();
    await expect(objectAction(deps, 'actMute', { object: { kind: 'person', id: 'u1', title: 'Аня' }, values: {} })).rejects.toThrow('с файлом');
    await expect(objectAction(deps, 'actMute', { object: { ...fileObject(), path: undefined }, values: {} })).rejects.toThrow('с файлом');
    await expect(objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 0 } })).rejects.toThrow('от 1 до 4000 МБ');
    await expect(objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 'много' } })).rejects.toThrow('от 1 до 4000 МБ');
    await expect(objectAction(deps, 'actDelete', { object: fileObject(), values: {} })).rejects.toThrow('Нет такого действия');
    await expect(objectAction(deps, 'actMute', null)).rejects.toThrow('с файлом');
    expect(started).toEqual([]);
  });
});

describe('«/сжать» in personal messages', () => {
  it('the person picks a video; one answer — pending with the size; with no way to upload, the end adds the hint to drag it', async () => {
    const { deps, started, emitted, events, job } = fakeDeps(['C:\\v\\trip.mp4']);
    const answer = await chatCompress(deps, { command: 'compress', values: { targetMB: 10 }, where: { kind: 'dm', conversationId: 'c1' } });
    expect(started[0]).toEqual({ path: 'C:\\v\\trip.mp4', op: 'compress', params: { mode: 'size', targetMB: 10 } });
    expect(answer).toEqual({ pending: 'job-1', message: 'Сжимаю «trip.mp4» до 10 МБ…' });
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\v\\trip (Quadro).mp4', inSize: 40 * MB, outSize: 9.8 * MB }));
    expect(emitted.at(-1)!.data.message).toBe('Готово «trip (Quadro).mp4»: 9,8 МБ, было 40 МБ — в папке «v». Перетащите файл в беседу');
  });

  it('the result goes to Hub as the person\'s file: «Отправляю…» at 99 %, then job.done with its fileId and picture size', async () => {
    const sent: string[] = [];
    const uploader: Uploader = {
      upload: async (path) => {
        sent.push(path);
        return { fileId: 'f-77' };
      },
      measure: async () => ({ width: 1280, height: 720 }),
    };
    const { deps, emitted, events, job } = fakeDeps(['C:\\v\\trip.mp4'], uploader);
    await chatCompress(deps, { values: { targetMB: 10 } });
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\v\\trip (Quadro).mp4', inSize: 40 * MB, outSize: 9.8 * MB }));
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\v\\trip (Quadro).mp4' })); // told once
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['C:\\v\\trip (Quadro).mp4']);
    expect(emitted.slice(-2)).toEqual([
      { name: 'job.progress', data: { jobId: 'job-1', percent: 99, message: 'Отправляю «trip (Quadro).mp4» в беседу' } },
      { name: 'job.done', data: { jobId: 'job-1', message: 'Готово «trip (Quadro).mp4»: 9,8 МБ, было 40 МБ — в папке «v»', kind: 'success', files: [{ fileId: 'f-77', width: 1280, height: 720 }] } },
    ]);
  });

  it('no picture size (ffprobe failed) — the file goes anyway; the upload refused — the line says why; an old program — the hint', async () => {
    const end = async (uploader: Uploader) => {
      const { deps, emitted, events, job } = fakeDeps(['C:\\v\\trip.mp4'], uploader);
      await chatCompress(deps, { values: { targetMB: 10 } });
      events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\v\\trip (Quadro).mp4', outSize: 2 * MB }));
      await new Promise((r) => setTimeout(r, 0));
      return emitted.at(-1)!;
    };
    expect((await end({ upload: async () => ({ fileId: 'f-1' }), measure: async () => Promise.reject(new Error('ffprobe')) })).data.files).toEqual([{ fileId: 'f-1' }]);
    const refused = await end({ upload: async () => Promise.reject(new Error('Нет места в ваших файлах: свободно 1 МБ')) });
    expect(refused).toEqual({ name: 'job.done', data: { jobId: 'job-1', message: 'Готово «trip (Quadro).mp4»: 2 МБ — в папке «v». Файл не отправился: Нет места в ваших файлах: свободно 1 МБ', kind: 'success' } });
    const old = await end({ upload: async () => Promise.reject(new Error('Нет такого действия: files.upload')) });
    expect(old.data).toEqual({ jobId: 'job-1', message: 'Готово «trip (Quadro).mp4»: 2 МБ — в папке «v». Перетащите файл в беседу', kind: 'success' });
  });

  it('the actions over a file of Hub never upload their result (it already lies in «Загрузки»)', async () => {
    const sent: string[] = [];
    const { deps, emitted, events, job } = fakeDeps([], { upload: async (p) => (sent.push(p), { fileId: 'x' }) });
    await objectAction(deps, 'actCompress', { object: fileObject(), values: { targetMB: 8 } });
    events.seen(job({ state: 'done', progress: 1, outPath: 'C:\\d\\clip (Quadro).mp4', outSize: MB }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
    expect(emitted.at(-1)!.data.files).toBeUndefined();
  });

  it('Windows\' window closed without a file — nothing is said', async () => {
    const { deps, started } = fakeDeps([]);
    expect(await chatCompress(deps, { values: { targetMB: 10 } })).toEqual({ type: 'ack' });
    expect(started).toEqual([]);
  });
});

describe('helpers', () => {
  it('objectFile keeps only a file with a path; targetOf defaults to 10 МБ; sizes in words', () => {
    expect(objectFile({ object: fileObject(), values: { targetMB: 5 } })).toEqual({ path: FILE, title: 'clip.mp4', mime: 'video/mp4', values: { targetMB: 5 } });
    expect(targetOf({})).toBe(10);
    expect(sizeText(512)).toBe('1 КБ');
    expect(sizeText(250 * MB)).toBe('250 МБ');
    expect(doneLine({ id: 'j', path: 'a.mp3', op: 'extractAudio', state: 'done', progress: 1, outPath: 'D:\\m\\a (Quadro).mp3', outSize: 900 * 1024 }, { op: 'extractAudio', title: 'a.mp4' })).toBe(
      'Готово «a (Quadro).mp3»: 900 КБ — в папке «m»',
    );
  });
});
