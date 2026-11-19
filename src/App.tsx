import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, AudioLines, Check, FileImage, FileVideo, FolderOpen, RotateCw, Scissors, Search, X } from 'lucide-react';
import { errorText, quadro, usePcEvents, useQuadro } from './quadro';
import { FORMATS, GROUPS, QUICK, canConvert, estimateBytes, targets, type Kind } from './formats';

// «Конвертер»'s screen in Hub's sandbox: every action goes to its own part on the PC (quadro.pc.call), the part's events
// (`job`) come back through quadro.pc.on. Files never leave the PC; FFmpeg came with the app (its download).

type Tab = 'convert' | 'compress' | 'video' | 'done';
type Probe = { kind: Kind; format: string; sizeBytes: number; durationSec?: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean };
type Item = { path: string; probe: Probe; to: string };
type Job = { id: string; state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; progress: number; etaSec?: number; outPath?: string; outSize?: number; inSize?: number; error?: string; path?: string; op?: string };
type Engine = { engine: 'missing' | 'ready'; version?: string; size?: number };
type Operation = { path: string; op: string; params: Record<string, unknown> };

const TABS: { id: Tab; label: string }[] = [
  { id: 'convert', label: 'Конвертировать' },
  { id: 'compress', label: 'Сжать' },
  { id: 'video', label: 'Видео' },
  { id: 'done', label: 'Готовое' },
];
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extension = (path: string) => basename(path).split('.').pop()?.toLowerCase() ?? '';
const size = (bytes?: number) => (bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} МБ`);
const clock = (s?: number) => (s == null ? '' : `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`);
const seconds = (value: string) => {
  const parts = value.split(':').map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? parts[0]! * 60 + parts[1]! : NaN;
};
/** What was done, in words (the part keeps the action's id). */
const OP_LABEL: Record<string, string> = { convert: 'Конвертация', compress: 'Сжатие', trim: 'Обрезка', removeAudio: 'Без звука', extractAudio: 'Только звук', gif: 'GIF', rotate: 'Поворот', resize: 'Новый размер' };
const STATE_LABEL: Record<Job['state'], string> = { queued: 'В очереди', running: 'В работе', done: 'Готово', failed: 'Ошибка', cancelled: 'Отменено' };
const KindIcon = ({ kind }: { kind: Kind }) => (kind === 'video' ? <FileVideo size={20} /> : kind === 'audio' ? <AudioLines size={20} /> : <FileImage size={20} />);
const pc = <T,>(method: string, params?: unknown) => quadro.pc.call<T>(method, params);

function ProgressBar({ value }: { value?: number }) {
  const pct = Math.max(0, Math.min(100, (value ?? 0) * 100));
  return (
    <div className="cv-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function App() {
  const { ctx, error } = useQuadro();
  if (error) {
    return (
      <main className="cv">
        <h1>Конвертер</h1>
        <p className="q-muted">Этот экран работает внутри Quadro Hub: поставьте «Конвертер» из Каталога.</p>
      </main>
    );
  }
  if (!ctx) return <main className="cv q-muted">Загрузка…</main>;
  if (ctx.pc === false) {
    return (
      <main className="cv">
        <h1>Конвертер</h1>
        <section className="q-card cv-empty">
          <FileVideo size={28} className="cv-accent" />
          <h2>Конвертер работает в программе Quadro Hub на ПК</h2>
          <p className="q-muted">Видео, аудио и картинки обрабатываются на вашем компьютере — файлы не уходят в интернет. Откройте Quadro Hub в программе для Windows.</p>
        </section>
      </main>
    );
  }
  return <ConvertScreen />;
}

function ConvertScreen() {
  const [tab, setTab] = useState<Tab>('convert');
  const [engine, setEngine] = useState<Engine | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [quick, setQuick] = useState<(typeof QUICK)[number] | null>(null);
  const [quality, setQuality] = useState(65);
  const [targetMB, setTargetMB] = useState('');
  const [tool, setTool] = useState('trim');
  const [start, setStart] = useState('00:00');
  const [end, setEnd] = useState('00:30');
  const [exact, setExact] = useState(false);
  const [audioTo, setAudioTo] = useState('mp3');
  const [deg, setDeg] = useState('90');
  const [width, setWidth] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [status, history] = await Promise.all([pc<Engine>('status'), pc<Job[]>('list')]);
      setEngine(status);
      setJobs(history ?? []);
    } catch (e) {
      setMessage(errorText(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  const onEvent = useCallback((name: string, data: unknown) => {
    if (name !== 'job') return;
    const next = data as Job;
    setJobs((previous) => [next, ...previous.filter((job) => job.id !== next.id)].slice(0, 200));
  }, []);
  usePcEvents(onEvent);

  const addPaths = useCallback(
    async (paths: string[]) => {
      setBusy(true);
      setMessage('');
      const added: Item[] = [];
      for (const path of paths) {
        if (items.some((item) => item.path === path)) continue;
        try {
          const probe = await pc<Probe>('probe', { path });
          if (!probe || !['video', 'audio', 'image'].includes(probe.kind)) throw new Error('Этот тип файла пока не поддерживается');
          const options = targets(probe.kind, probe.hasAudio);
          const preferred = quick && (quick.from === 'video' ? probe.kind === 'video' : extension(path) === quick.from) ? quick.to : null;
          added.push({ path, probe, to: preferred && options.includes(preferred) ? preferred : (options.find((f) => f !== extension(path)) ?? options[0]!) });
        } catch (e) {
          setMessage(`${basename(path)}: ${errorText(e)}`);
        }
      }
      setItems((old) => [...old, ...added]);
      setBusy(false);
    },
    [items, quick],
  );
  const pick = async () => {
    try {
      await addPaths((await pc<string[]>('pickFiles')) ?? []);
    } catch (e) {
      setMessage(errorText(e));
    }
  };
  const startJobs = async (operations: Operation[]) => {
    if (!operations.length) return;
    setBusy(true);
    setMessage('');
    try {
      await pc('start', { items: operations, out: { mode: 'next' } });
      await refresh();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const updateItem = (path: string, to: string) => setItems((old) => old.map((item) => (item.path === path ? { ...item, to } : item)));
  const removeItem = (path: string) => setItems((old) => old.filter((item) => item.path !== path));
  const video = items.find((item) => item.probe.kind === 'video');
  const ready = engine?.engine === 'ready';
  const runVideo = () => {
    if (!video) return;
    const params: Record<string, unknown> = {};
    if (tool === 'trim' || tool === 'gif') {
      const a = seconds(start);
      const b = seconds(end);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || (video.probe.durationSec && b > video.probe.durationSec)) {
        setMessage('Проверьте начало и конец фрагмента');
        return;
      }
      params.start = a;
      params.end = b;
      if (tool === 'trim') params.exact = exact;
    }
    if (tool === 'extractAudio') params.to = audioTo;
    if (tool === 'rotate') params.deg = Number(deg);
    if (tool === 'resize') {
      if (!Number(width) || Number(width) < 1) {
        setMessage('Укажите ширину в пикселях');
        return;
      }
      params.width = Number(width);
    }
    void startJobs([{ path: video.path, op: tool, params }]);
  };
  const active = useMemo(() => jobs.filter((job) => job.state === 'queued' || job.state === 'running'), [jobs]);
  const done = useMemo(() => jobs.filter((job) => job.state === 'done'), [jobs]);
  const queue = useMemo(() => jobs.filter((job) => job.state !== 'done').slice(0, 8), [jobs]);

  return (
    <main className="cv">
      <header>
        <h1>Конвертер</h1>
        <p className="q-muted">Видео, аудио и картинки — на вашем ПК</p>
      </header>

      {/* FFmpeg comes with the app from the catalog (its download): missing — install again. */}
      {engine && !ready && (
        <section className="q-card cv-alert" role="alert">
          <h2>FFmpeg не найден</h2>
          <p className="q-muted">Он ставится вместе с Конвертером. Откройте Конвертер в Каталоге и нажмите «Поставить» ещё раз — файлы на ПК не пострадают.</p>
        </section>
      )}

      <div className="cv-tabs" role="tablist" aria-label="Разделы конвертера">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="cv-tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {message && (
        <div className="q-card cv-message" role="alert">
          <span>{message}</span>
          <button type="button" className="q-btn cv-icon" aria-label="Закрыть сообщение" onClick={() => setMessage('')}>
            <X size={16} />
          </button>
        </div>
      )}

      {tab === 'convert' && (
        <section className="q-stack">
          <div className="cv-wrap">
            {QUICK.map((entry) => (
              <button
                key={entry.label}
                type="button"
                className="q-btn"
                aria-pressed={quick?.label === entry.label}
                onClick={() => {
                  setQuick(entry);
                  setItems((old) => old.map((item) => ((entry.from === 'video' ? item.probe.kind === 'video' : extension(item.path) === entry.from) ? { ...item, to: entry.to } : item)));
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {quick && <p className="cv-accent">Быстрый путь: {quick.label}. Выберите файл.</p>}
          <div className="q-card cv-drop">
            <FileVideo size={36} className="cv-accent" />
            <h2>Выберите файлы для конвертации</h2>
            <p className="q-muted">Видео, аудио и картинки. Можно выбрать сразу несколько.</p>
            <button type="button" className="q-btn q-btn-primary" onClick={() => void pick()} disabled={busy}>
              <FolderOpen size={16} /> Выбрать файлы
            </button>
          </div>
          {items.length > 0 && (
            <ul className="q-list">
              {items.map((item) => (
                <li key={item.path} className="cv-item">
                  <span className="cv-accent">
                    <KindIcon kind={item.probe.kind} />
                  </span>
                  <div className="cv-grow">
                    <div className="cv-name" title={item.path}>
                      {basename(item.path)}
                    </div>
                    <div className="q-subtle">
                      {size(item.probe.sizeBytes)} {clock(item.probe.durationSec)} {item.probe.width && item.probe.height ? `· ${item.probe.width}×${item.probe.height}` : ''}
                    </div>
                  </div>
                  <FormatPicker item={item} search={search} onSearch={setSearch} onChange={(to) => updateItem(item.path, to)} />
                  <button type="button" className="q-btn cv-icon" aria-label={`Убрать ${basename(item.path)}`} onClick={() => removeItem(item.path)}>
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <button
              type="button"
              className="q-btn q-btn-primary"
              disabled={!items.length || busy || !ready}
              onClick={() =>
                void startJobs(items.filter((item) => canConvert(extension(item.path), item.to, item.probe.hasAudio)).map((item) => ({ path: item.path, op: 'convert', params: { to: item.to } })))
              }
            >
              Конвертировать всё
            </button>
          </div>
        </section>
      )}

      {tab === 'compress' && (
        <section className="q-stack">
          <div className="q-card q-stack">
            <div>
              <h2>Сжать файлы</h2>
              <p className="q-muted">Подберите качество или укажите предельный размер.</p>
            </div>
            <div>
              <button type="button" className="q-btn" onClick={() => void pick()}>
                <FolderOpen size={16} /> Добавить файлы
              </button>
            </div>
            <div className="cv-between">
              <span>Размер</span>
              <span>Качество · {quality}%</span>
            </div>
            <input
              aria-label="Качество"
              type="range"
              min="0"
              max="100"
              value={quality}
              className="cv-range"
              onChange={(e) => {
                setQuality(Number(e.target.value));
                setTargetMB('');
              }}
            />
            <div className="cv-wrap cv-end">
              <label className="q-label cv-field">
                До N МБ
                <input className="q-input" type="number" min="0.1" step="0.1" value={targetMB} onChange={(e) => setTargetMB(e.target.value)} placeholder="Размер" />
              </label>
              {(
                [
                  ['Discord 10 МБ', '10'],
                  ['Discord 25 МБ', '25'],
                  ['Telegram', '50'],
                ] as const
              ).map(([label, value]) => (
                <button key={label} type="button" className="q-btn" onClick={() => setTargetMB(value)}>
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="q-btn"
                onClick={() => {
                  setTargetMB('');
                  setWidth('1024');
                }}
              >
                Для Roblox (картинка 1024)
              </button>
            </div>
          </div>
          {items.length > 0 && (
            <ul className="q-list">
              {items.map((item) => (
                <li key={item.path} className="cv-item">
                  <span className="cv-accent">
                    <KindIcon kind={item.probe.kind} />
                  </span>
                  <span className="cv-grow cv-name">{basename(item.path)}</span>
                  <span className="q-muted">
                    Было {size(item.probe.sizeBytes)} → станет ~{size(estimateBytes(item.probe.sizeBytes, item.probe.durationSec, quality, Number(targetMB) || undefined))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <button
              type="button"
              className="q-btn q-btn-primary"
              disabled={!items.length || busy || !ready}
              onClick={() =>
                void startJobs(
                  items.map((item) => ({
                    path: item.path,
                    op: 'compress',
                    params: targetMB ? { mode: 'size', targetMB: Number(targetMB) } : { mode: 'quality', quality, ...(width && item.probe.kind === 'image' ? { maxWidth: Number(width) } : {}) },
                  })),
                )
              }
            >
              Сжать всё
            </button>
          </div>
        </section>
      )}

      {tab === 'video' && (
        <section className="cv-two">
          <div className="q-card q-stack">
            <h2>Видео</h2>
            <div>
              <button type="button" className="q-btn" onClick={() => void pick()}>
                <FolderOpen size={16} /> Выбрать видео
              </button>
            </div>
            {video ? (
              <div className="cv-item cv-boxed">
                <FileVideo size={20} className="cv-accent" />
                <div className="cv-grow">
                  <div className="cv-name">{basename(video.path)}</div>
                  <div className="q-subtle">
                    {clock(video.probe.durationSec)} · {size(video.probe.sizeBytes)}
                  </div>
                </div>
              </div>
            ) : (
              <p className="q-muted">Добавьте видео, чтобы выбрать действие.</p>
            )}
          </div>
          <div className="q-card q-stack">
            <h2>Инструмент</h2>
            <select className="q-select" aria-label="Инструмент" value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="trim">Обрезать</option>
              <option value="removeAudio">Убрать звук</option>
              <option value="extractAudio">Только звук</option>
              <option value="gif">В GIF</option>
              <option value="rotate">Повернуть</option>
              <option value="resize">Изменить размер</option>
            </select>
            {(tool === 'trim' || tool === 'gif') && (
              <div className="q-stack">
                <div className="q-row">
                  <label className="q-label cv-field">
                    Начало
                    <input className="q-input" aria-label="Начало" value={start} onChange={(e) => setStart(e.target.value)} placeholder="мм:сс" />
                  </label>
                  <label className="q-label cv-field">
                    Конец
                    <input className="q-input" aria-label="Конец" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="мм:сс" />
                  </label>
                </div>
                {video?.probe.durationSec ? (
                  <input
                    aria-label="Начало фрагмента"
                    className="cv-range"
                    type="range"
                    min="0"
                    max={Math.max(1, Math.floor(video.probe.durationSec) - 1)}
                    value={Math.min(seconds(start) || 0, video.probe.durationSec - 1)}
                    onChange={(e) => setStart(clock(Number(e.target.value)))}
                  />
                ) : null}
                {tool === 'trim' && (
                  <label className="q-row">
                    <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} /> Точно по кадру — дольше
                  </label>
                )}
              </div>
            )}
            {tool === 'extractAudio' && (
              <select className="q-select" aria-label="Формат аудио" value={audioTo} onChange={(e) => setAudioTo(e.target.value)}>
                {FORMATS.audio.map((format) => (
                  <option key={format} value={format}>
                    {format.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
            {tool === 'rotate' && (
              <select className="q-select" aria-label="Поворот" value={deg} onChange={(e) => setDeg(e.target.value)}>
                {['90', '180', '270'].map((value) => (
                  <option key={value} value={value}>
                    {value}°
                  </option>
                ))}
              </select>
            )}
            {tool === 'resize' && <input className="q-input" aria-label="Ширина в пикселях" type="number" min="1" placeholder="Ширина в пикселях" value={width} onChange={(e) => setWidth(e.target.value)} />}
            <div>
              <button type="button" className="q-btn q-btn-primary" disabled={!video || busy || !ready} onClick={runVideo}>
                {tool === 'trim' ? <Scissors size={16} /> : tool === 'rotate' ? <RotateCw size={16} /> : <Check size={16} />} Начать
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === 'done' && (
        <section className="q-stack">
          {done.length ? (
            <ul className="q-list">
              {done.map((job) => (
                <li key={job.id} className="cv-item">
                  <Check size={20} className="cv-accent" />
                  <div className="cv-grow">
                    <div className="cv-name">{basename(job.outPath ?? job.path ?? job.id)}</div>
                    <div className="q-subtle">
                      {(job.op && OP_LABEL[job.op]) ?? 'Готово'} · {size(job.inSize)} → {size(job.outSize)}
                      {job.inSize && job.outSize ? ` · ${Math.round((1 - job.outSize / job.inSize) * 100)}%` : ''}
                    </div>
                  </div>
                  {job.outPath && (
                    <>
                      <button type="button" className="q-btn" onClick={() => void pc('reveal', { path: job.outPath }).catch((e) => setMessage(errorText(e)))}>
                        <FolderOpen size={16} /> Показать в папке
                      </button>
                      <button type="button" className="q-btn" onClick={() => void pc('open', { path: job.outPath }).catch((e) => setMessage(errorText(e)))}>
                        Открыть
                      </button>
                    </>
                  )}
                  {job.path && job.op && (
                    <button
                      type="button"
                      className="q-btn"
                      onClick={() => {
                        setTab(job.op === 'compress' ? 'compress' : job.op === 'convert' ? 'convert' : 'video');
                        void addPaths([job.path!]);
                      }}
                    >
                      Повторить
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="q-card cv-empty">
              <Archive size={24} className="q-muted" />
              <h2>Готовых файлов пока нет</h2>
              <p className="q-muted">Результаты появятся здесь после обработки.</p>
            </div>
          )}
        </section>
      )}

      <section className="q-card q-stack">
        <div className="cv-between">
          <h2>Очередь заданий</h2>
          <span className="q-subtle">{active.length} в работе</span>
        </div>
        {queue.length ? (
          queue.map((job) => (
            <div key={job.id} className="cv-job">
              <div className="q-row">
                <span className="cv-grow cv-name">{basename(job.path ?? job.outPath ?? job.id)}</span>
                <span className="q-muted">
                  {STATE_LABEL[job.state]} {job.etaSec != null && job.state === 'running' ? `· осталось ${clock(job.etaSec)}` : ''}
                </span>
                {active.includes(job) && (
                  <button type="button" className="q-btn" onClick={() => void pc('cancel', { id: job.id }).catch((e) => setMessage(errorText(e)))}>
                    Отменить
                  </button>
                )}
              </div>
              {job.state === 'running' && <ProgressBar value={job.progress} />}
              {job.error && <p className="cv-error">{job.error}</p>}
            </div>
          ))
        ) : (
          <p className="q-muted">Очередь пуста</p>
        )}
      </section>

      <section className="q-card q-row q-muted">
        <Archive size={20} />
        <div>
          <span className="cv-strong">Скоро</span> · Документы, PDF, текст из картинки, архивы и книги.
        </div>
      </section>
    </main>
  );
}

function FormatPicker({ item, search, onSearch, onChange }: { item: Item; search: string; onSearch: (value: string) => void; onChange: (value: string) => void }) {
  const allowed = targets(item.probe.kind, item.probe.hasAudio);
  const groups: Kind[] = item.probe.kind === 'video' ? ['video', 'audio'] : [item.probe.kind];
  return (
    <div className="q-row">
      <Search size={16} className="q-muted" />
      <input className="q-input cv-search" aria-label={`Поиск формата для ${basename(item.path)}`} placeholder="Поиск" value={search} onChange={(e) => onSearch(e.target.value)} />
      <select className="q-select cv-format" aria-label={`Формат для ${basename(item.path)}`} value={item.to} onChange={(e) => onChange(e.target.value)}>
        {groups.map((kind) => {
          const formats = allowed.filter((format) => FORMATS[kind].includes(format) && format.includes(search.toLowerCase()));
          return formats.length ? (
            <optgroup key={kind} label={GROUPS[kind]}>
              {formats.map((format) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
    </div>
  );
}
