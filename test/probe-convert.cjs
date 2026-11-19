// The screen of «Конвертер» in a copy of Hub, through Hub's hidden-window probe (no window on the screen, no real input):
//   QUADRO_PROBE_LOGIN=test_owner:<password> electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 \
//     --path p/quadro.convert --steps test/probe-convert.cjs        (the copy started with HUB_DEV_PACKAGES=<this folder>)
// 1) in a browser (no program): the screen says it works in the program;
// 2) with a stand-in of the program's bridge quadroDesktop.parts (sample answers of the part, never a real file of the PC):
//    the full screen, picking files, starting a job and its events, the «Готовое» tab.
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';

/** In the page's own world: a stand-in of the program's bridge to the parts — answers of quadro.convert's part. */
const STAND_IN = `(() => {
  const listeners = new Set();
  const emit = (name, data) => listeners.forEach((fn) => fn({ appId: 'quadro.convert', name, data }));
  const jobs = [
    { id: 'j1', path: 'C:\\\\Видео\\\\стрим.mov', op: 'convert', state: 'done', progress: 1, inSize: 52428800, outSize: 18874368, outPath: 'C:\\\\Видео\\\\стрим (Quadro).mp4' },
    { id: 'j2', path: 'C:\\\\Картинки\\\\обложка.png', op: 'compress', state: 'done', progress: 1, inSize: 3145728, outSize: 734003, outPath: 'C:\\\\Картинки\\\\обложка (Quadro).png' },
    { id: 'j3', path: 'C:\\\\Видео\\\\битый.avi', op: 'convert', state: 'failed', progress: 0, error: 'FFmpeg не смог прочитать файл' },
  ];
  const probes = {
    'C:\\\\Видео\\\\клип.mp4': { kind: 'video', format: 'mp4', sizeBytes: 41943040, durationSec: 95, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    'C:\\\\Картинки\\\\фото.png': { kind: 'image', format: 'png', sizeBytes: 2097152, width: 2048, height: 1536, hasVideo: true, hasAudio: false },
  };
  window.__pcCalls = [];
  window.quadroDesktop = Object.assign(window.quadroDesktop || {}, { parts: {
    has: (appId) => Promise.resolve(appId === 'quadro.convert'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    call: (appId, method, params) => {
      window.__pcCalls.push(appId + ' ' + method);
      if (appId !== 'quadro.convert') return Promise.reject(new Error('Нет части'));
      switch (method) {
        case 'status': return Promise.resolve({ engine: 'ready', version: '9.0.2', size: 1 });
        case 'list': return Promise.resolve(jobs.slice());
        case 'pickFiles': return Promise.resolve(Object.keys(probes));
        case 'probe': return probes[params.path] ? Promise.resolve(probes[params.path]) : Promise.reject(new Error('Файл не найден'));
        case 'start': {
          const ids = params.items.map((it, i) => 'n' + i);
          params.items.forEach((it, i) => {
            const job = { id: ids[i], path: it.path, op: it.op, state: 'running', progress: 0.42, etaSec: 37, inSize: probes[it.path] ? probes[it.path].sizeBytes : 0 };
            jobs.unshift(job);
            setTimeout(() => emit('job', job), 50);
          });
          return Promise.resolve({ ids });
        }
        default: return Promise.resolve(null);
      }
    },
  } });
  return true;
})()`;

module.exports = async (probe) => {
  const { win, js, wait, until, shot, log } = probe;
  const frame = () => win.webContents.mainFrame.framesInSubtree.find((f) => f !== win.webContents.mainFrame && /pkg|package|sandbox|blob|null/i.test(f.url + f.origin) && f.url !== 'about:blank') || win.webContents.mainFrame.frames[0];
  const inFrame = async (expr) => {
    const f = win.webContents.mainFrame.framesInSubtree.filter((x) => x !== win.webContents.mainFrame);
    for (const x of f) {
      try {
        const has = await x.executeJavaScript('!!document.querySelector(".cv")');
        if (has) return x.executeJavaScript(expr);
      } catch {}
    }
    return null;
  };
  const untilFrame = async (expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await inFrame(expr);
      if (v) return v;
      if (Date.now() > end) throw new Error('не дождался в кадре: ' + expr);
      await wait(250);
    }
  };
  const click = (text) => inFrame(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);

  // 1) A browser: no program, no part.
  await until('!!document.querySelector("iframe")', 30000);
  const browserText = await untilFrame('document.querySelector(".cv") && document.body.innerText', 30000);
  log('BROWSER', JSON.stringify(browserText.slice(0, 200)));
  if (!/работает в программе/.test(browserText)) throw new Error('в браузере экран не сказал, что работает в программе');
  await shot(`${OUT}/convert-browser.png`);

  // 2) The program's bridge (stand-in), the frame made anew by going away and back inside the page.
  await js(STAND_IN);
  await js(`(() => { const p = location.pathname; history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); setTimeout(() => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, 400); return true; })()`);
  await wait(1500);
  await untilFrame('document.body.innerText.includes("Конвертировать всё")', 30000);
  await shot(`${OUT}/convert-main.png`);

  if (!(await click('Выбрать файлы'))) throw new Error('нет кнопки «Выбрать файлы»');
  await untilFrame('document.body.innerText.includes("клип.mp4") && document.body.innerText.includes("фото.png")', 15000);
  await shot(`${OUT}/convert-picked.png`);
  if (!(await click('Конвертировать всё'))) throw new Error('нет кнопки «Конвертировать всё»');
  await untilFrame('document.body.innerText.includes("осталось 00:37")', 15000);
  log('QUEUE', JSON.stringify((await inFrame('document.body.innerText')).match(/Очередь заданий[\s\S]{0,200}/)?.[0]));
  await shot(`${OUT}/convert-queue.png`);

  await click('Готовое');
  await untilFrame('document.body.innerText.includes("стрим (Quadro).mp4")', 10000);
  await shot(`${OUT}/convert-done.png`);
  log('CALLS', JSON.stringify(await js('window.__pcCalls')));
};
