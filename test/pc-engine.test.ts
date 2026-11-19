import { describe, expect, it } from 'vitest';
import { ConvertEngine, type EngineFiles, ffmpegArgs, oversized, progressOf, resultPath, shaMatches, windowsTar, type Item, type Probe } from '../pc/engine';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';


/** The program's side of the person's files (pc-apps/files.ts), as simple as the engine needs: real files of the test folder. */
const filesOf = (taken = new Set<string>()): EngineFiles => ({
  stat: async (path) => {
    try {
      const s = statSync(path);
      return { exists: true, isFile: s.isFile(), size: s.isFile() ? s.size : 0 };
    } catch {
      return { exists: false, isFile: false, size: 0 };
    }
  },
  outputPath: async (path, ext) => {
    const out = resultPath(path, ext, undefined, (p) => existsSync(p) || taken.has(String(p)));
    taken.add(out);
    return out;
  },
  remove: async (path) => rmSync(path, { force: true }),
});

const info: Probe = { kind: 'video', format: 'mov', sizeBytes: 100000, durationSec: 10, width: 640, height: 360, hasVideo: true, hasAudio: true, codecs: ['h264', 'aac'] };
const item = (op: Item['op'], params: Record<string, unknown> = {}): Item => ({ path: 'C:\\clip.mov', op, params });
const args = (op: Item['op'], params: Record<string, unknown> = {}, probe = info, output = 'C:\\out.mp4') => ffmpegArgs(item(op, params), probe, output);

describe('Convert FFmpeg commands', () => {
  it('copies compatible video and encodes webm', () => {
    expect(args('convert', { to: 'mp4' })).toContain('copy');
    expect(args('convert', { to: 'webm' })).toContain('libvpx-vp9');
  });
  it('encodes audio and images', () => {
    expect(args('convert', { to: 'mp3' })).toContain('libmp3lame');
    const image: Probe = { ...info, kind: 'image', format: 'png', hasAudio: false, durationSec: undefined };
    expect(args('convert', { to: 'webp' }, image)).toContain('85');
    expect(args('convert', { to: 'ico' }, image)).toContain('scale=256:256:force_original_aspect_ratio=decrease');
  });
  it('builds compression, trim and extraction', () => {
    expect(args('compress', { mode: 'quality' })).toContain('23');
    expect(args('compress', { mode: 'size', targetMB: 1 })).toContain('-pass');
    expect(args('trim', { start: 1, end: 3 })).toContain('copy');
    expect(args('trim', { start: 1, end: 3, exact: true })).toContain('libx264');
    expect(args('removeAudio')).toContain('-an');
    expect(args('extractAudio', { to: 'flac' })).toContain('flac');
  });
  it('builds gif, rotate and resize', () => {
    expect(args('gif', { fps: 10 }).join(' ')).toContain('[v0]palettegen[p]');
    expect(args('rotate', { deg: 90 })).toContain('transpose=1');
    expect(args('resize', { width: 701 })).toContain('scale=700:-2:force_original_aspect_ratio=decrease');
  });
  it('names results without overwrite', () => {
    expect(resultPath('C:\\a.mp4', 'webm', 'C:\\', p => String(p).endsWith('a (Quadro).webm'))).toBe('C:\\a (Quadro) (2).webm');
  });
  it('parses progress and rejects larger compressed output', () => {
    expect(progressOf('out_time_ms=5000000', 10)).toBe(0.5);
    expect(oversized(100, 101)).toBe(true);
    expect(oversized(100, 90)).toBe(false);
  });
  it('checks archive bytes against pinned hash', () => {
    const bytes = Buffer.from('abc');
    expect(shaMatches(bytes, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe(true);
    expect(shaMatches(Buffer.from('changed'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe(false);
  });
  it('cancels a job before conversion starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quadro-convert-test-'));
    try {
      mkdirSync(join(dir, 'ffmpeg', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'ffmpeg', 'bin', 'ffmpeg.exe'), '');
      writeFileSync(join(dir, 'ffmpeg', 'bin', 'ffprobe.exe'), '');
      const source = join(dir, 'source.mp4'); writeFileSync(source, 'sample');
      let conversions = 0;
      const spawn = (cmd: string): ChildProcess => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new EventEmitter(); const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, kill: () => true });
        if (cmd.endsWith('ffmpeg.exe')) conversions++;
        queueMicrotask(() => { stdout.emit('data', Buffer.from('{"format":{"format_name":"mov","duration":"1"},"streams":[{"codec_type":"video","codec_name":"h264"}]}')); child.emit('close', 0); });
        return child;
      };
      const engine = new ConvertEngine({ dataDir: dir, bin: join(dir, 'ffmpeg', 'bin'), files: filesOf(), spawn, emit: () => undefined, busy: () => undefined });
      const { ids } = await engine.start([{ path: source, op: 'convert', params: { to: 'webm' } }]);
      engine.cancel(ids[0]!);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(engine.list()[0]!.state).toBe('cancelled');
      expect(conversions).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const ffmpeg = process.env.FFMPEG_PATH ?? (process.platform === 'win32' ? 'C:/ffmpeg-8.0-essentials_build/bin/ffmpeg.exe' : 'ffmpeg');
  it.skipIf(spawnSync(ffmpeg, ['-version'], { timeout: 5000 }).status !== 0)('converts a tiny real video', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quadro-convert-real-'));
    try {
      const source = join(dir, 'source.mp4'); const result = join(dir, 'result.webm');
      const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 30_000 });
      expect(generated.status).toBe(0);
      const command = ffmpegArgs({ path: source, op: 'convert', params: { to: 'webm' } }, { ...info, hasAudio: false, sizeBytes: 1000 }, result);
      const converted = spawnSync(ffmpeg, command, { timeout: 30_000 });
      expect(converted.status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe('two passes to a size', () => {
  it('share the bar: the first goes to 50 %, the second on to 100 % (19.11: the bar stood at 99 % through the second)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quadro-convert-pass-'));
    try {
      mkdirSync(join(dir, 'ffmpeg', 'bin'), { recursive: true });
      for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) writeFileSync(join(dir, 'ffmpeg', 'bin', exe), '');
      const source = join(dir, 'clip.mp4');
      writeFileSync(source, 'x'.repeat(5_000_000));
      const spawn = (cmd: string, a: string[]): ChildProcess => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new EventEmitter();
        Object.assign(child, { stdout, stderr: new EventEmitter(), kill: () => true });
        queueMicrotask(() => {
          if (cmd.endsWith('ffprobe.exe')) stdout.emit('data', Buffer.from('{"format":{"format_name":"mov","duration":"10"},"streams":[{"codec_type":"video","codec_name":"h264"}]}'));
          else {
            // Each pass reports its own 0…99 %: half-way, then near its end.
            stdout.emit('data', Buffer.from('out_time_ms=5000000\nout_time_ms=9900000\n'));
            if (!a.includes('NUL')) writeFileSync(a[a.length - 1]!, 'small');
          }
          child.emit('close', 0);
        });
        return child;
      };
      const seen: number[] = [];
      const engine = new ConvertEngine({
        dataDir: dir,
        bin: join(dir, 'ffmpeg', 'bin'),
        files: filesOf(),
        spawn,
        emit: (name, data) => name === 'job' && seen.push((data as { progress: number }).progress),
        busy: () => undefined,
      });
      await engine.start([{ path: source, op: 'compress', params: { mode: 'size', targetMB: 1 } }]);
      await new Promise((r) => setTimeout(r, 100));
      expect(engine.list()[0]!.state).toBe('done');
      const steps = seen.filter((p) => p > 0 && p < 1).map((p) => Math.round(p * 100));
      // Before: 50, 99 — and nothing more through the whole second pass.
      expect(steps).toEqual([25, 50, 75, 100]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('unpacking FFmpeg', () => {
  it('takes Windows’ own tar by its full path (a GNU tar of Git first on PATH reads «C:» as a remote host)', () => {
    expect(windowsTar({ SystemRoot: 'D:\\Win' })).toBe(join('D:\\Win', 'System32', 'tar.exe'));
    expect(windowsTar({})).toBe(join('C:\\Windows', 'System32', 'tar.exe'));
  });
});
