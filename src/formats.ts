export type Kind = 'video' | 'audio' | 'image';
export const FORMATS: Record<Kind, readonly string[]> = {
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'gif'],
  audio: ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', 'aac'],
  image: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico'],
};
export const GROUPS: Record<Kind, string> = { video: 'Видео', audio: 'Аудио', image: 'Картинки' };
const VIDEO_INPUT = new Set([...FORMATS.video.filter((format) => format !== 'gif'), 'flv', 'wmv']);
const AUDIO_INPUT = new Set([...FORMATS.audio, 'wma']);
const IMAGE_INPUT = new Set(FORMATS.image);
export function kindOf(extension: string): Kind | null {
  const ext = extension.toLowerCase();
  return VIDEO_INPUT.has(ext) ? 'video' : AUDIO_INPUT.has(ext) ? 'audio' : IMAGE_INPUT.has(ext) ? 'image' : null;
}
export function targets(kind: Kind, hasAudio = true): string[] {
  if (kind === 'video') return [...FORMATS.video, ...(hasAudio ? FORMATS.audio : [])];
  return [...FORMATS[kind]];
}
export function canConvert(source: string, target: string, hasAudio = true): boolean {
  const kind = kindOf(source);
  return !!kind && targets(kind, hasAudio).includes(target.toLowerCase());
}
export const QUICK = [
  { from: 'mp4', to: 'mp3', label: 'MP4 → MP3' },
  { from: 'mov', to: 'mp4', label: 'MOV → MP4' },
  { from: 'png', to: 'jpg', label: 'PNG → JPG' },
  { from: 'webp', to: 'png', label: 'WEBP → PNG' },
  { from: 'video', to: 'gif', label: 'Видео → GIF' },
] as const;
export function quickTarget(source: string): string | null {
  return QUICK.find((item) => item.from === source.toLowerCase())?.to ?? (kindOf(source) === 'video' ? 'gif' : null);
}
export function estimateBytes(inputBytes: number, durationSec: number | undefined, quality: number, targetMB?: number): number {
  if (targetMB && targetMB > 0) return Math.min(inputBytes, targetMB * 1024 * 1024);
  const ratio = 0.12 + Math.max(0, Math.min(100, quality)) / 100 * 0.76;
  const bitrate = durationSec && durationSec > 0 ? inputBytes * 8 / durationSec : null;
  return Math.min(inputBytes, Math.round(bitrate && durationSec ? bitrate * ratio * durationSec / 8 : inputBytes * ratio));
}
