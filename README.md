# Конвертер — пакет Quadro Hub (`quadro.convert`)

Видео, аудио и картинки в любой формат на ПК человека. Сделан путём стороннего автора: свой проект вне ядра Hub,
публичный SDK, подписанный пакет `.qhapp`, загрузка в Каталог от аккаунта владельца (издатель `quadro`).

```
manifest.json        манифест 2: экран (views.main), кнопка на полосе, часть на ПК с FFmpeg в downloads, права
index.html, src/     экран в песочнице Hub (React): мост /pkg-sdk/v1/quadro.js, вид /pkg-sdk/v1/quadro-ui.css
  App.tsx            разделы «Конвертировать», «Сжать», «Видео», «Готовое», очередь; всё через quadro.pc.call
  quadro.ts          хуки моста: useQuadro, useKv, useSettings, usePcEvents (события части `job`)
  formats.ts         форматы и оценка размера
pc/                  часть на ПК (Node, @quadrohub/pc-sdk): engine.ts — FFmpeg, очередь, двухпроходное сжатие; part.ts — методы;
                     actions.ts — действия над видео Hub и «/сжать» в личке
scripts/build-pc.mjs часть одним файлом dist/pc/part.cjs (pc-sdk вшит)
test/                тесты движка и собранной части (как её запускает программа: IPC, hello, вызовы экрана)
dist/                после сборки — сам пакет (manifest.json + client/ + pc/)
```

## Снаружи экрана (1.2.0–1.2.2)

- **Действия над файлами Hub** (`shell.objectAction@1`, `run: pc`, `match.mime`):
  - у видео (`video/*`) — «Убрать звук», «Сжать…» (форма Hub, 10 МБ по умолчанию) и «Вытащить звук в mp3»;
  - у звука (`audio/*`) — «Перевести в mp3»; mp3 остаётся как есть, ответ «уже в mp3».
  Они стоят в меню у файла в чатах и личке. Программа скачивает файл в «Загрузки\Quadro Hub» и отдаёт его части как
  выбранный человеком. Результат кладётся рядом с файлом.
- **«Открыть с помощью»** (`shell.openWith@1`) для видео и звука: экран Конвертера с файлом. Файлы приходят через
  `quadro.context.files` или событие `files.open`.
- **`/сжать` в личке** (`servers.command@1`, `scopes: dm, self`, `pc:chatCompress`): форма с размером, видео
  выбирается окном Windows.
- **Ответ — сразу** (kernel.md §12ж), потому что программа ждёт вызов части не больше 60 с:
  - часть отвечает `{ pending: jobId, message }` (у `/сжать` — с размером: «Сжимаю «…» до 10 МБ…»);
  - дальше шлёт события `job.progress { jobId, percent, message }` и в конце `job.done { jobId, message, kind }` или
    `job.failed { jobId, message }`;
  - Hub держит одно уведомление с процентами до конца (`JobEvents` в `pc/actions.ts`).
- Инструментов для ИИ нет, поэтому подсказки `readOnly`, `destructive` и `openWorld` не нужны. Права — как в 1.1.0.

## Собрать и проверить

```bash
npm install
npm run build        # dist/ = пакет
npm test             # движок + собранная часть
npm run typecheck
```

Посмотреть экран без публикации — своя копия Hub читает пакеты с диска (только не рабочий Hub):

```bash
HUB_DEV_PACKAGES="<путь к этой папке>" node scripts/dev.mjs --addr apps.localhost --web-port 5291 --api-port 8891
```

В браузере экран покажет «работает в программе» — часть на ПК есть только в программе Quadro Hub.

Действия, «Открыть с помощью» и `/сжать` с настоящей частью проверяются скрытым окном программы в режиме автора
(`test/probe-actions.cjs`, как запускать — в начале файла). Нужна личка с видео `.mp4` и звуком `.mp3` на своей
копии Hub. Окно выбора файла заменяет `QUADRO_PROBE_FILES`, поэтому окна Windows не открываются.

## Выпуск из CI (с 1.2.3)

Тег `v<версия>` (та же, что в `manifest.json`) запускает `.github/workflows/release.yml` в github.com/maxbizak/quadro-convert:
`npm ci`, сборка, `qhapp-1.0.10.mjs` со сверкой sha256 и `ci-publish dist --hub https://quadro-metaverse.site`. Ключей нет ни в
репозитории, ни в секретах: Hub меняет токен GitHub на сертификат на час. В Каталоге у версии — «Собрано из
github.com/maxbizak/quadro-convert@…». Доверие workflow — «Каталог → Опубликовать → Выпуск из CI». Ручная подпись ниже —
запасной путь.

## Упаковать, подписать, отправить

Ключ автора издателя `quadro` — `~/.quadro/keys/quadro-1.key` (закрытый, только на этом ПК), открытый ключ —
`~/.quadro/keys/quadro-1.pub.txt`. Из репозитория Quadro Hub:

```bash
npm run qhapp -- pack "<эта папка>/dist" --out "<эта папка>/out/quadro.convert-1.0.0.qhapp" --key ~/.quadro/keys/quadro-1.key --kid quadro-1
npm run qhapp -- check "<эта папка>/out/quadro.convert-1.0.0.qhapp" --publisher quadro --trust official --key quadro-1=<открытый ключ>
```

Отправка — MCP `catalog_version_submit` (base64 файла) или «Каталог → Опубликовать». Новая версия — поднять `version`
в `manifest.json` и повторить.
