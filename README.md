# dsh-lightrag — база знаний LightRAG для DeepSeek Harness

Плагин для [DeepSeek Harness](https://github.com/DeepSeek-Harness) (dsh), подключающий
[LightRAG](https://lightrag.github.io/) (graph-RAG, HKUDS) как **базу знаний агента**:
документы загружаются на сервер LightRAG, агент задаёт вопросы по графу знаний
и получает ответы со ссылками на исходные документы.

## Инструменты, доступные агенту

| Инструмент | Назначение |
|---|---|
| `lightrag_query` | Вопрос к базе знаний (режимы `mix/local/global/hybrid/naive/bypass`, формат ответа, `top_k`, только контекст без генерации). Возвращает ответ + ссылки на документы. |
| `lightrag_ingest_text` | Добавить документ из текста (→ `track_id`). |
| `lightrag_ingest_file` | Загрузить файл из рабочей директории (multipart, → `track_id`). |
| `lightrag_track` | Проверить прогресс индексирования по `track_id` (опционально — опрос до завершения). |
| `lightrag_status` | Здоровье сервера, состояние пайплайна индексации, количество документов по статусам. |
| `lightrag_documents` | Список документов (пагинация, фильтр по статусу, сортировка). |
| `lightrag_delete_document` | Удалить документ по id (необратимо). |

Плагин также добавляет в системный промпт агента секцию о базе знаний —
агент сам знает, когда использовать `lightrag_query` вместо `web_search`.

## Веб-страница (внутри GUI DSH)

Плагин регистрирует SSR-страницу **http://127.0.0.1:3080/lightrag-docs**
в веб-сервере GUI (маршруты `exact /lightrag-docs` + `prefix /lightrag-docs/action`).

- Таблица документов: имя (с превью-контентом в tooltip), статус, размер, дата, ID.
- Фильтры-чипы по статусам, поиск по имени, пагинация (50/стр).
- 📤 **Загрузить документ** — файл до 20 МБ; расширение проверяется по живому
  списку сервера (`GET /documents/supported_file_types`); файл шлётся base64-формой,
  хост записывает временный файл и грузит его на сервер `POST /documents/upload`.
- 🗑 **Удалить все документы** — подтверждение вводом слова «УДАЛИТЬ»;
  `DELETE /documents` (кэш `__parsed__` сохраняется).
- ✕ Удаление одного документа (с подтверждением).
- ↻ **Переработать ошибочные** — появляется, когда есть документы в статусе
  `failed` (или при фильтре по статусу «ошибка»); `POST /documents/reprocess_failed`
  возвращает упавшие записи в пайплайн (LLM-извлечение повторится, кэш уже
  выполненных шагов экономит время).
- Строки `failed` показывают причину падения (`error_msg`) в tooltip имени файла.
- Бейндж занятого пайплайна, баннеры (загружено/удалено/переработано/ошибка),
  автообновление каждые 15 с.

Все обращения к LightRAG-серверу идут со стороны хоста (curl из процесса dsh) —
CORS не нужен. Страница переживает перезапуск dsh web (часть плагина профиля).

## Требования

- Сервер `lightrag-server` (pip-пакет `lightrag-hku`), по умолчанию слушает `http://127.0.0.1:9621`.
- Node.js ≥ 20 (fetch/FormData/Blob из коробки).

## Установка

```bash
# в профиле web:
dsh plugin --profile web add /home/sa/automation/dsh-lightrag
```

После установки профиль перезагрузится (у web-профиля `patchReload: live`) —
в **новой** сессии появятся инструменты `lightrag_*`.

## Конфигурация

| Параметр | Переменная окружения | По умолчанию |
|---|---|---|
| Адрес сервера LightRAG | `LIGHTRAG_BASE_URL` | `http://127.0.0.1:9621` |
| API-ключ (заголовок `Authorization: Bearer …`) | `LIGHTRAG_API_KEY` | — |
| Режим запросов по умолчанию | — (config `queryMode` в `cordis.patch.yml`) | `mix` |
| Таймаут запросов, мс | — (config `timeoutMs`) | `180000` |

Переменные окружения задаются для **процесса dsh** (того, что запускает `dsh web`),
например в скрипте автозапуска:

```bash
export LIGHTRAG_BASE_URL="http://<адрес-сервера-lightrag>:9621"
export LIGHTRAG_API_KEY="..."   # если сервер запущен с --api-key
```

либо правкой `cordis.patch.yml` плагина (значения без `!!js` — константы).

Для сервера в локальной сети, например:

```bash
export LIGHTRAG_BASE_URL="http://192.168.1.50:9621"
```

### Локальная установка сервера (выполнена)

Сервер развёрнут в WSL из GitHub (HKUDS/LightRAG, ветка main, `[api]`),
актуальный каталог — `/home/sa/automation/lightrag` (автозапуск
`autostart/start-services.sh` из `/etc/wsl.conf [boot]`; раннее рабочее место
`/home/sa/andrey/work/lightrag` сохранено как запасной инстанс):

```bash
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python "git+https://github.com/HKUDS/LightRAG.git[api]"
lightrag-server   # конфиг в /home/sa/andrey/work/lightrag/.env
```

Текущая конфигурация (`.env`): LLM `qwen3.5-122b-a10b-fp8-dynamic` через
**failover-прокси** `http://127.0.0.1:8901/v1` (primary — gpustack
`https://gpustack.rtk-cd.ru/v1`, резерв — vLLM
`http://192.168.60.200:8001/v1`), эмбеддинги `BAAI/bge-m3` (1024 мер) через
vLLM `http://192.168.60.200:8003/v1`, `LLM_TIMEOUT=600`,
`EMBEDDING_TIMEOUT=300`, `MAX_PARALLEL_INSERT=1`, `SUMMARY_LANGUAGE=Russian`,
хранилища — JSON/NanoVectorDB/NetworkX в `rag_storage/`.

> Замечание: извлечение сущностей идёт через LLM — время зависит от загрузки
> машины с моделями (gpustack-сервер общий: возможны задержки).
> Для больших документов заложите время или уменьшите параллелизм/чанки.

### LLM failover-прокси (`failover/`)

`failover/llm_failover_proxy.py` — OpenAI-совместимый прокси на
`127.0.0.1:8901`, который LightRAG использует как `LLM_BINDING_HOST`.
Защищает индексацию от падений GPU-бэкендов:

1. **primary** — `https://gpustack.rtk-cd.ru/v1` (заголовок `Authorization`
   клиента пересылается как есть);
2. **backup** — `http://192.168.60.200:8001/v1` (vLLM) — включается при
   connect-error, таймауте или 408/429/5xx **до первого байта ответа**;
   имя модели переписывается в `RedHatAI/Qwen3.6-35B-A3B-NVFP4`.

После сбоя primary трафик идёт сразу в резерв (cooldown 60 с), фоновый
сондаж `GET /models` каждые 20 с возвращает его на primary. Дедлайны:
primary 300 с, резерв 280 с (сумма < `LLM_TIMEOUT`). `GET /health` —
состояние и счётчики маршрутизации; `GET /v1/models` — сводный список
модели обоих бэкендов.

> Эмбеддинги failover не имеют: `BAAI/bge-m3` обслуживает только Spark `:8003`,
> подменить модель нельзя (векторы 1024d несовместимы — база перестаёт
> отвечать по запросам к старым документам).

```bash
bash failover/failover-start.sh   # идемпотентный запуск (лог: logs/failover-proxy.log)
```

В автозапуске прокси стартует первым шагом `autostart/start-services.sh`.

## Типовой сценарий

1. `lightrag_status` — убедиться, что сервер жив и пайплайн свободен.
2. `lightrag_ingest_file` / `lightrag_ingest_text` — добавить документы.
3. `lightrag_track` (waitSeconds) — дождаться `PROCESSED`.
4. `lightrag_query` — отвечать на вопросы по документам.
5. `lightrag_documents` (status=FAILED) — диагностика проблем.

## Тесты

```bash
cd /home/sa/automation/dsh-lightrag
node test/mock-test.mjs
```

Самодостаточный тест: поднимает мок-сервер LightRAG (все REST-эндпоинты)
и прогоняет клиента и все 7 инструментов, включая авторизацию, опрос
прогресса и обработку ошибок.

## Используемый REST API сервера (совместимость, v1.5.x)

```
GET    /health
POST   /query                       {query, mode, only_need_context?, response_type?, top_k?, user_prompt?, include_references?}
POST   /documents/text              {text, file_source?}                → {status, message, track_id}
POST   /documents/upload            multipart `file`                    → {status, message, track_id}
POST   /documents/paginated         {page, page_size(10..200), status_filter?, sort_field, sort_direction}
GET    /documents/status_counts     → {status_counts: {pending, parsing, …, all}}
GET    /documents/supported_file_types
GET    /documents/pipeline_status
GET    /documents/track_status/{id}
DELETE /documents/delete_document   {doc_ids: [doc-…], delete_file?}
DELETE /documents                   ?delete_parsed_files (по умолчанию false)
POST   /documents/reprocess_failed  {}                                → {reprocessed_count, …}
```

Статусы документов (в API — **строчные**):
`pending | preprocessed | parsing | analyzing | processing | processed | failed`.

Нюансы v1.5.x:
- `DELETE /documents/delete_document` требует поле `doc_ids` (массив);
  `doc_id` → 422.
- `POST /documents/text` под конкурентной индексацией может терять запись
  `doc_status` (контент при этом попадает в граф) — плагин поэтому ведёт текст
  через временный файл и `/documents/upload`.
- Удаление может «зависнуть» после KG-rebuild; перезапуск сервера LightRAG
  разблокирует очередь.
- Имена файлов с `/` сервер отклоняет («Unsafe filename») — плагин санитизирует.

## Безопасность (анти-утечка секретов)

`scripts/secret-scan.mjs` — «агент по безопасности» репозитория. Сканит
рабочее дерево **и полную git-историю** (все ветки) и блокирует:

- **запрещённые пути**: `.env*`, `*.pem/*.key/*.p12`, `id_rsa*`,
  `rag_storage/`, `inputs/`, `logs/`, `__parsed__/`, архивы/бэкапы;
- **известные форматы секретов**: GitHub PAT (`ghp_…`, `github_pat_…`),
  OpenAI/Anthropic (`sk-…`, `sk-ant-…`), AWS (`AKIA…`), Slack, Telegram-bot,
  JWT, блоки `-----BEGIN … PRIVATE KEY`;
- **общие паттерны**: `api_key/secret/token/password = <значение ≥16 символов>`,
  кроме явных плейсхолдеров (`not-needed`, `ollama`, `changeme`, `<…>`, `$VAR`).

```bash
node scripts/secret-scan.mjs         # проверка всего (дерево + история)
node scripts/secret-scan.mjs --tree  # только рабочее дерево (быстро)
```

`pre-push`-хук (`scripts/hooks/pre-push`) запускает скан перед каждым пушем
и **прерывает пуш**, если найдены нарушения. Включение для локального клона:

```bash
git config core.hooksPath scripts/hooks
```

Правила игнорирования — в `.gitignore` (`.env*`, `rag_storage/`, `inputs/`,
`logs/`, архивы/бэкапы). API-ключи живут только в `.env` развернутого
сервера и в переменных окружения процесса dsh — никогда в git.

## Структура

```
dsh-lightrag/
├── package.json            # метаданные, dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml        # слой патча: запись `lightrag` в дерево профиля
├── lib/index.js            # клиент LightRAG REST + 7 инструментов + SSR-страница /lightrag-docs + apply(ctx, config)
├── failover/               # LLM failover-прокси (primary gpustack → backup vLLM) + start-скрипт
├── scripts/
│   ├── secret-scan.mjs     # сканер секретов (дерево + история)
│   └── hooks/pre-push      # git-хук: блокирует пуш при утечках
├── test/mock-test.mjs      # тесты с мок-сервером
└── node_modules/           # dev-ссылки на dsh-tools/schemastery (не публикуются)
```
