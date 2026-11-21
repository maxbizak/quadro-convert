// «Конвертер» 1.2.6: «Показать в папке» under «/сжать»'s result in the conversation with «Конвертер» — a button of the person's own PC
// (servers.interaction@1 `pc: ['revealResult']`): the press reaches this part, which shows the result in its folder. Runs
// probe-dm-result.cjs first (the result with its file and button), then presses the button, hidden window only:
//   the same environment as probe-actions.cjs (program 1.0.108+, a Hub with pc buttons without a handler); the program's stand-in
//   of «Показать в папке» prints «REVEAL <path>» instead of opening Explorer (the probe's log shows it).
/* eslint-disable */
const dmResult = require('./probe-dm-result.cjs');

module.exports = async (probe) => {
  const { js, wait, log } = probe;
  await dmResult(probe);
  // probe-dm-result left the page on the conversation with «Конвертер»: the newest message's button.
  const until = async (expr, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await js(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error('не дождался: ' + expr);
      await wait(250);
    }
  };
  await until(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Показать в папке').length > 0`, 20000);
  const before = await js(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`);
  await js(`(() => { const all = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Показать в папке'); all.at(-1).click(); return all.length; })()`);
  await wait(4000);
  const toasts = (await js(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`)).filter((t) => !before.includes(t));
  log('TOASTS', JSON.stringify(toasts));
  if (toasts.some((t) => /не объявило|работает в программе|Ошибка|не найден|Нет такого|Не открыть|нет в истории/i.test(t))) throw new Error('кнопка не сработала: ' + toasts.join(' | '));
  await probe.shot(`${process.env.PROBE_OUT || '.'}/cv-reveal.png`);
  log('OK', '«Показать в папке» из лички дошла до части (REVEAL в журнале программы)');
};
