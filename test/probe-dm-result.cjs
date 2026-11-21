// «Конвертер» 1.2.5: «/сжать»'s result comes into the person's conversation with «Конвертер» as its message with the video (the part
// uploads it — host.files.upload, pc.files.upload; Hub puts job.done's files there). Runs probe-actions.cjs as it is, then checks
// the conversation, hidden window only:
//   the same environment as probe-actions.cjs (program 1.0.108+, a Hub that puts job.done's files into the conversation), and
//   electron <Hub>/apps/desktop/scripts/probe.cjs … --steps test/probe-dm-result.cjs
/* eslint-disable */
const actions = require('./probe-actions.cjs');

module.exports = async (probe) => {
  const { js, wait, log } = probe;
  const since = new Date().toISOString();
  await actions(probe);
  const get = (p) => js(`fetch('/api' + ${JSON.stringify(p)}, { credentials: 'include' }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }))`);
  const end = Date.now() + 240_000;
  for (;;) {
    const list = (await get('/dm/conversations')).b || [];
    const conv = (Array.isArray(list) ? list : []).find((c) => c.kind === 'app' && c.appId === 'quadro.convert');
    if (conv) {
      const m = (await get(`/dm/conversations/${conv.id}/messages`)).b;
      const items = Array.isArray(m) ? m : m?.items || [];
      const hit = items.find((x) => (x.createdAt || '') > since && /клип-pick/.test(x.body || '') && (x.attachments || []).length);
      if (hit) {
        const a = hit.attachments[0];
        log('DM-RESULT', JSON.stringify({ body: hit.body, file: { name: a.name, mime: a.mime, size: a.size, width: a.width, height: a.height } }));
        if (!/^video\//.test(a.mime || '')) throw new Error('в беседе не видео: ' + a.mime);
        const head = await js(`fetch(${JSON.stringify(a.url)}, { credentials: 'include' }).then((r) => r.status + ' ' + r.headers.get('content-type'))`);
        log('FILE', head);
        if (!/^200 video\//.test(head)) throw new Error('Hub не отдаёт файл: ' + head);
        await js(`location.assign('/me/dm/' + ${JSON.stringify(conv.id)})`);
        await wait(5000);
        await probe.shot(`${process.env.PROBE_OUT || '.'}/cv-dm-result.png`);
        break;
      }
    }
    if (Date.now() > end) throw new Error('итог /сжать не пришёл в беседу с Конвертером файлом');
    await wait(2000);
  }
  log('OK', 'итог /сжать — сообщение Конвертера с видео в беседе с ним');
};
