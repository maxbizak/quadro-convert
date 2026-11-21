// «Конвертер» 1.2.2 from outside its screen, in a copy of Hub with the real program's bridges and the real part (author mode),
// hidden window only (no window on the screen, no real input — the page is driven by its own JavaScript):
//   QUADRO_PROBE_LOGIN=test_owner:<password> QUADRO_DEV_PACKAGES=<this folder>\dist QUADRO_PROBE_FILES=<a video> \
//   PROBE_OUT=<folder> PROBE_DOWNLOADS=<apps>\Загрузки\Quadro Hub \
//   electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 --path me/dm/<conversation> --bridges \
//     --apps <apps> --steps test/probe-actions.cjs        (the copy started with HUB_DEV_PACKAGES=<this folder>; the conversation
//     has a video .mp4 and a sound .mp3 of Hub)
// 1) the menu over the video: «Открыть с помощью → Конвертер» and the actions «Убрать звук», «Сжать…», «Вытащить звук в mp3»;
// 2) each action: the program downloads the file of Hub, the part does the work, the shell's line says what came out — and the
//    file is there; «Сжать…» asks Hub's form first (10 МБ by default); «Повторить» appears after it;
// 3) the sound's «Открыть в «Конвертер»» and the video's «Открыть с помощью → Конвертер»: its screen lists the file;
// 4) «/сжать» in the personal conversation: Hub's form, the video picked (QUADRO_PROBE_FILES — Windows' window never opens), the
//    notice «Готово … Перетащите файл в беседу».
/* eslint-disable */
const { existsSync, readdirSync, statSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');

const OUT = process.env.PROBE_OUT || '.';
const DOWN = process.env.PROBE_DOWNLOADS || '';
const PICKED = (process.env.QUADRO_PROBE_FILES || '').split(';').filter(Boolean)[0] || '';

module.exports = async (probe) => {
  const { win, js, wait, until, log } = probe;
  const conversation = await js('location.pathname');
  const shot = async (file) => {
    const [w, h] = win.getSize();
    win.setSize(w, h + 1);
    await wait(400);
    win.setSize(w, h);
    await wait(500);
    await probe.shot(`${OUT}/${file}`);
  };
  const toasts = () => js(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`);
  // The notices already shown are only remembered, never removed from the page: Hub updates a notice in place (pending → done),
  // and a node taken from under React stops all later notices.
  let seen = new Set();
  const toastLike = async (re, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const all = ((await toasts()) || []).filter((t) => !seen.has(t));
      const hit = all.find((t) => re.test(t));
      if (hit) return hit;
      const bad = all.find((t) => /Ошибка|не удалось|не найден|не получилось|Нет такого/i.test(t));
      if (bad) throw new Error('ошибка вместо результата: ' + bad);
      if (Date.now() > end) throw new Error('не дождался строки ' + re + ' — сейчас: ' + JSON.stringify(all));
      await wait(500);
    }
  };
  const clearToasts = async () => {
    seen = new Set((await toasts()) || []);
  };
  // The menu of one file: `pick` — JavaScript giving its «Открыть с помощью» button (the video's player, or the n-th sound).
  // An open menu closes by Escape on the menu itself (the shell's menus listen there, not on <body>); waited until it is gone.
  const closeMenus = async () => {
    for (let i = 0; i < 5; i++) {
      if (!(await js(`document.querySelectorAll('[role="menu"]').length`))) return;
      await js(`(() => { const m = [...document.querySelectorAll('[role="menu"]')].at(-1); (m || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
      await wait(300);
    }
    if (await js(`document.querySelectorAll('[role="menu"]').length`)) throw new Error('меню не закрылось');
  };
  const menuOf = async (pick) => {
    await closeMenus();
    await until(`!!(${pick})`, 60000);
    await js(`(${pick}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))`);
    await until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 10000);
    await wait(700); // «Повторить» is asked when the menu opens
    return js(`[...document.querySelectorAll('[role="menu"]')].map((m) => m.innerText.trim().split(/\\n+/)).flat()`);
  };
  // The video's button: the one whose menu sits in the player (its parent chain holds the <video>).
  const VIDEO_BUTTON = `[...document.querySelectorAll('button[aria-label="Открыть с помощью"]')].find((b) => { for (let e = b.parentElement; e; e = e.parentElement) if (e.querySelector('video')) return true; return false; })`;
  // The n-th sound of the conversation (звук.mp3 was sent first, голос.ogg after it).
  const soundButton = (n) => `([...document.querySelectorAll('audio')][${n}] || {}).parentElement?.querySelector('button[aria-label="Открыть с помощью"]')`;
  const videoMenu = () => menuOf(VIDEO_BUTTON);
  const choose = (title) => js(`(() => { const i = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === ${JSON.stringify(title)});
    if (!i) return false; i.click(); return true; })()`);
  const files = () => (DOWN && existsSync(DOWN) ? readdirSync(DOWN) : []);
  const frameText = async () => {
    for (const f of win.webContents.mainFrame.framesInSubtree.filter((x) => x !== win.webContents.mainFrame)) {
      try {
        if (await f.executeJavaScript('!!document.querySelector(".cv")')) return String(await f.executeJavaScript('document.body.innerText'));
      } catch {}
    }
    return '';
  };
  const frameHas = async (needle, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await frameText();
      if (t.includes(needle)) return t;
      if (Date.now() > end) throw new Error('экран Конвертера без «' + needle + '»: ' + t.slice(0, 300));
      await wait(500);
    }
  };

  // 1) The menu over the video.
  const menu = await videoMenu();
  log('MENU', JSON.stringify(menu));
  for (const need of ['Открыть с помощью', '«Конвертер»', 'Убрать звук', 'Сжать…', 'Вытащить звук в mp3'])
    if (!menu.includes(need)) throw new Error('в меню нет «' + need + '»: ' + JSON.stringify(menu));
  if (menu.includes('Перевести в mp3')) throw new Error('у видео действие звука: ' + JSON.stringify(menu));
  await shot('cv-menu.png');

  // 2) «Убрать звук»: the first call starts the part (its FFmpeg is fetched once in the author mode).
  await clearToasts();
  if (!(await choose('Убрать звук'))) throw new Error('не нажалось «Убрать звук»');
  const muted = await toastLike(/Готово «клип.*\.mp4»/, 6 * 60_000);
  log('MUTE', muted);
  await shot('cv-mute-done.png');

  await videoMenu();
  await clearToasts();
  await choose('Вытащить звук в mp3');
  const audio = await toastLike(/Готово «клип.*\.mp3»/, 120_000);
  log('AUDIO', audio);

  // «Сжать…»: Hub's form, 10 МБ by default; 5 МБ asked.
  await videoMenu();
  await clearToasts();
  await choose('Сжать…');
  await until(`!!document.querySelector('#hub-form input[type="number"]')`, 10000);
  const given = await js(`document.querySelector('#hub-form input[type="number"]').value`);
  if (String(given) !== '10') throw new Error('в форме не 10 МБ по умолчанию: ' + given);
  await js(`(() => { const i = document.querySelector('#hub-form input[type="number"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '5'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await wait(300);
  await shot('cv-compress-form.png');
  await js(`document.querySelector('button[type="submit"][form="hub-form"]').click()`);
  // Hub keeps the notice with the percent of the part's job.progress until job.done.
  let percent = '';
  for (const end = Date.now() + 60_000; Date.now() < end && !percent; ) {
    percent = ((await toasts()) || []).find((t) => /Сжимаю «клип.*» \d+%/.test(t)) || '';
    if (!percent) await wait(150);
  }
  log('PROGRESS', percent);
  if (!percent) throw new Error('не было уведомления с процентами');
  await shot('cv-compress-progress.png');
  const compressed = await toastLike(/Готово «клип.*\.mp4»: .* было/, 180_000);
  log('COMPRESS', compressed);
  await shot('cv-compress-done.png');

  const made = files();
  log('DOWNLOADS', JSON.stringify(made.map((f) => `${f} ${statSync(join(DOWN, f)).size}`)));
  if (!made.some((f) => /\(Quadro.*\)\.mp3$/.test(f))) throw new Error('нет mp3 рядом с файлом');
  if (made.filter((f) => /\(Quadro.*\)\.mp4$/.test(f)).length < 1) throw new Error('нет видео-результата');

  // «Повторить» — the last action on this video.
  // Hub asks «Повторить» each time the menu opens; until its answer the menu may show the one of last time — opened again then.
  let again = await videoMenu();
  log('MENU-AGAIN', JSON.stringify(again));
  for (let i = 0; i < 3 && !again.some((t) => /^Повторить: Сжать/.test(t)); i++) {
    log('MENU-AGAIN-STALE', 'меню показало прошлое «Повторить», открываю снова');
    await wait(1500);
    again = await videoMenu();
  }
  if (!again.some((t) => /^Повторить: Сжать/.test(t))) throw new Error('нет «Повторить: Сжать…»: ' + JSON.stringify(again));
  await shot('cv-relaunch.png');
  await closeMenus();

  // The sounds (match.mime «audio/*»): «Перевести в mp3» — the ogg becomes an mp3, the mp3 stays as it is; no video actions.
  const oggMenu = await menuOf(soundButton(1));
  log('MENU-OGG', JSON.stringify(oggMenu));
  for (const need of ['«Конвертер»', 'Перевести в mp3'])
    if (!oggMenu.includes(need)) throw new Error('в меню звука нет «' + need + '»: ' + JSON.stringify(oggMenu));
  if (oggMenu.some((t) => /Убрать звук|Сжать|Вытащить/.test(t))) throw new Error('у звука действия видео: ' + JSON.stringify(oggMenu));
  await shot('cv-menu-ogg.png');
  await clearToasts();
  await choose('Перевести в mp3');
  const toMp3 = await toastLike(/Готово «голос.*\.mp3»/, 120_000);
  log('TO-MP3', toMp3);
  await shot('cv-to-mp3-done.png');
  await menuOf(soundButton(0));
  await clearToasts();
  await choose('Перевести в mp3');
  const already = await toastLike(/уже в mp3/, 30_000);
  log('ALREADY-MP3', already);

  // 3) «Открыть с помощью → Конвертер» of the sound: the screen with the file.
  await menuOf(soundButton(0));
  await choose('«Конвертер»');
  await until(`location.pathname.includes('quadro.convert')`, 15000);
  const screen = await frameHas('звук', 60000);
  log('OPEN-WITH', JSON.stringify(screen.slice(0, 300)));
  await shot('cv-openwith-audio.png');

  // …and the video's «Открыть с помощью → Конвертер».
  await js(`history.back()`);
  await until(`location.pathname.startsWith('/me/dm/')`, 15000);
  await videoMenu();
  await choose('«Конвертер»');
  await until(`location.pathname.includes('quadro.convert')`, 15000);
  await frameHas('клип', 60000);
  await shot('cv-openwith-video.png');

  // 4) «/сжать» in the personal conversation.
  await js(`location.assign(${JSON.stringify(conversation)})`);
  await until(`!!document.querySelector('textarea')`, 30000);
  await wait(1500);
  await js(`(() => { const t = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '/сж'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.body.innerText.includes('/сжать')`, 10000);
  await shot('cv-slash.png');
  await clearToasts();
  const before = PICKED ? readdirSync(dirname(PICKED)).length : 0;
  await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await until(`!!document.querySelector('#hub-form input[type="number"]')`, 10000);
  await js(`document.querySelector('button[type="submit"][form="hub-form"]').click()`);
  // One answer: Hub follows the job (pending → percent → «Готово … Перетащите файл в беседу»), no second line of a «reply».
  const chat = await toastLike(/Перетащите файл в беседу|Сжимаю «клип-pick.*» до 10 МБ/, 120_000);
  log('SLASH', chat);
  await shot('cv-slash-done.png');
  if (PICKED) {
    // The result next to the picked video (a Hub whose «/» in personal messages does not follow pending says only «Сжимаю…»).
    const end = Date.now() + 180_000;
    while (readdirSync(dirname(PICKED)).length <= before && Date.now() < end) await wait(1000);
    const next = readdirSync(dirname(PICKED)).filter((f) => f.startsWith(basename(PICKED, '.mp4') + ' (Quadro'));
    log('PICKED-RESULT', JSON.stringify(next.map((f) => `${f} ${statSync(join(dirname(PICKED), f)).size}`)));
    if (readdirSync(dirname(PICKED)).length <= before) throw new Error('нет результата рядом с выбранным видео');
    await wait(1500);
    const end2 = (await toasts()) || [];
    log('SLASH-END', JSON.stringify(end2));
    const twice = end2.filter((t) => /клип-pick/.test(t) && !seen.has(t));
    if (twice.length > 1) throw new Error('два ответа на /сжать: ' + JSON.stringify(twice));
    await shot('cv-slash-end.png');
  }
  log('OK', 'действия над видео с процентами, форма, «Повторить», «Открыть с помощью» и /сжать работают');
};
