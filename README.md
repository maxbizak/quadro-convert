# Конвертер — пакет Quadro Hub (`quadro.convert`)

Видео, аудио и картинки в любой формат на ПК человека. Сделан путём стороннего автора: свой проект вне ядра Hub,
публичный SDK, подписанный пакет `.qhapp`, загрузка в Каталог от аккаунта владельца (издатель `quadro`).

```
manifest.json        манифест 2: экран (views.main), кнопка на полосе, часть на ПК с FFmpeg в downloads, права
index.html, src/     экран в песочнице Hub (React): мост /pkg-sdk/v1/quadro.js, вид /pkg-sdk/v1/quadro-ui.css
  App.tsx            разделы «Конвертировать», «Сжать», «Видео», «Готовое», очередь; всё через quadro.pc.call
  quadro.ts          хуки моста: useQuadro, useKv, useSettings, usePcEvents (события части `job`)
  formats.ts         форматы и оценка размера
pc/                  часть на ПК (Node, @quadrohub/pc-sdk): engine.ts — FFmpeg, очередь, двухпроходное сжатие; part.ts — методы
scripts/build-pc.mjs часть одним файлом dist/pc/part.cjs (pc-sdk вшит)
test/                тесты движка и собранной части (как её запускает программа: IPC, hello, вызовы экрана)
dist/                после сборки — сам пакет (manifest.json + client/ + pc/)
```

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

## Упаковать, подписать, отправить

Ключ автора издателя `quadro` — `~/.quadro/keys/quadro-1.key` (закрытый, только на этом ПК), открытый ключ —
`~/.quadro/keys/quadro-1.pub.txt`. Из репозитория Quadro Hub:

```bash
npm run qhapp -- pack "<эта папка>/dist" --out "<эта папка>/out/quadro.convert-1.0.0.qhapp" --key ~/.quadro/keys/quadro-1.key --kid quadro-1
npm run qhapp -- check "<эта папка>/out/quadro.convert-1.0.0.qhapp" --publisher quadro --trust official --key quadro-1=<открытый ключ>
```

Отправка — MCP `catalog_version_submit` (base64 файла) или «Каталог → Опубликовать». Новая версия — поднять `version`
в `manifest.json` и повторить.
