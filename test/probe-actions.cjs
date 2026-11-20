// «Конвертер» 1.2.0 from outside its screen, in a copy of Hub with the real program's bridges and the real part (author mode),
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
// 4) «/compress» in the personal conversation: Hub's form, the video picked (QUADRO_PROBE_FILES — Windows' window never opens), the
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
  const toastLike = async (re, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const all = (await toasts()) || [];
      const hit = all.find((t) => re.test(t));
      if (hit) return hit;
      const bad = all.find((t) => /Ошибка|не удалось|не найден|не получилось|Нет такого/i.test(t));
      if (bad) throw new Error('ошибка вместо результата: ' + bad);
      if (Date.now() > end) throw new Error('не дождался строки ' + re + ' — сейчас: ' + JSON.stringify(all));
      await wait(500);
    }
  };
  const clearToasts = () => js(`document.querySelectorAll('[data-sonner-toast]').forEach((t) => t.remove())`);
  const videoMenu = async () => {
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(300);
    await until(`!!document.querySelector('video') && [...document.querySelectorAll('button[aria-label="Открыть с помощью"]')].length > 0`, 60000);
    await js(`(() => { const b = [...document.querySelectorAll('button[aria-label="Открыть с помощью"]')][0];
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); })()`);
    await until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 10000);
    await wait(700); // «Повторить» is asked when the menu opens
    return js(`[...document.querySelectorAll('[role="menu"]')].map((m) => m.innerText.trim().split(/\\n+/)).flat()`);
  };
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
  const compressed = await toastLike(/Готово «клип.*\.mp4»: .* было|Сжимаю «клип/, 120_000);
  log('COMPRESS', compressed);
  await shot('cv-compress-done.png');

  const made = files();
  log('DOWNLOADS', JSON.stringify(made.map((f) => `${f} ${statSync(join(DOWN, f)).size}`)));
  if (!made.some((f) => /\(Quadro.*\)\.mp3$/.test(f))) throw new Error('нет mp3 рядом с файлом');
  if (made.filter((f) => /\(Quadro.*\)\.mp4$/.test(f)).length < 1) throw new Error('нет видео-результата');

  // «Повторить» — the last action on this video.
  const again = await videoMenu();
  log('MENU-AGAIN', JSON.stringify(again));
  if (!again.some((t) => /^Повторить: Сжать/.test(t))) throw new Error('нет «Повторить: Сжать…»');
  await shot('cv-relaunch.png');
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // 3) «Открыть в Конвертер» of the sound: the screen with the file.
  await until(`!!document.querySelector('button[aria-label^="Открыть в «Конвертер"]')`, 10000);
  await js(`document.querySelector('button[aria-label^="Открыть в «Конвертер"]').click()`);
  await until(`location.pathname.includes('quadro.convert')`, 15000);
  const screen = await frameHas('звук.mp3', 60000);
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

  // 4) «/compress» in the personal conversation.
  await js(`location.assign(${JSON.stringify(conversation)})`);
  await until(`!!document.querySelector('textarea')`, 30000);
  await wait(1500);
  await js(`(() => { const t = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '/comp'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.body.innerText.includes('/compress')`, 10000);
  await shot('cv-slash.png');
  await clearToasts();
  await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await until(`!!document.querySelector('#hub-form input[type="number"]')`, 10000);
  await js(`document.querySelector('button[type="submit"][form="hub-form"]').click()`);
  const chat = await toastLike(/Перетащите файл в беседу|Сжимаю «/, 120_000);
  log('SLASH', chat);
  await shot('cv-slash-done.png');
  if (PICKED) {
    const next = readdirSync(dirname(PICKED)).filter((f) => f.startsWith(basename(PICKED, '.mp4') + ' (Quadro'));
    log('PICKED-RESULT', JSON.stringify(next));
    if (/Перетащите/.test(chat) && !next.length) throw new Error('нет результата рядом с выбранным видео');
  }
  log('OK', 'действия над видео, форма, «Повторить», «Открыть с помощью» и /compress работают');
};
