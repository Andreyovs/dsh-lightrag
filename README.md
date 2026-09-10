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

## Веб-интерфейс (внутри GUI DSH)

Страница управления документами: **http://127.0.0.1:3080/lightrag-docs**

- Загрузка: файлы (drag&drop, мультизагрузка) и текст.
- Список документов: поиск по имени, фильтр по статусу, автообновление во время индексации.
- Карточка документа (модалка), повторная обработка FAILED, удаление (с подтверждением).
- Живой прогресс недавних загрузок (опрос track_id).

Технически: React SPA (сборка Vite в `ui/dist`) + API-прокси
`/api/lightrag-docs/*` — оба маршрута регистрируются плагином в веб-сервере
GUI (только loopback). Переговоры с LightRAG-сервером идут на стороне плагина,
CORS не нужен.

Сборка UI (требуется только при изменении исходников в `ui/`):

```bash
cd ui && npm install && npm run build   # результат: ui/dist
```

## Требования

- Сервер `lightrag-server` (pip-пакет `lightrag-hku`), по умолчанию слушает `http://127.0.0.1:9621`.
- Node.js ≥ 20 (fetch/FormData/Blob из коробки).

## Установка

```bash
# в профиле web:
dsh plugin --profile web add /home/sa/work/dsh-lightrag
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
export LIGHTRAG_BASE_URL="http://<адрес-сервера>:9621"
```

### Локальная установка сервера

Сервер разворачивается в WSL из GitHub (HKUDS/LightRAG, ветка main, `[api]`):

```bash
# каталог: ~/work/lightrag
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python "git+https://github.com/HKUDS/LightRAG.git[api]"
lightrag-server   # конфиг в ~/work/lightrag/.env
```

Пример конфигурации (`.env`): любой OpenAI-совместимый бэкенд (GPUStack,
vLLM и т.п.) — `LLM_BINDING=openai`, `LLM_BINDING_HOST=https://<gpu-host>/v1`,
`EMBEDDING_BINDING=openai`, `EMBEDDING_MODEL=<embedding-модель>`,
`EMBEDDING_DIM=<размерность>`, `SUMMARY_LANGUAGE=Russian`; хранилища —
JSON/NanoVectorDB/NetworkX в `WORKING_DIR`.

Проверено: индексация русского документа (9 сущностей / 9 связей),
запрос возвращает ответ с фактами и ссылкой на источник.

> Замечание: извлечение сущностей идёт через LLM — для первого документа
> ~10 минут (зависит от загрузки gpustack). Для больших корпоративных
> документов заложите время или уменьшите параллелизм/размер чанков.

## Типовой сценарий

1. `lightrag_status` — убедиться, что сервер жив и пайплайн свободен.
2. `lightrag_ingest_file` / `lightrag_ingest_text` — добавить документы.
3. `lightrag_track` (waitSeconds) — дождаться `PROCESSED`.
4. `lightrag_query` — отвечать на вопросы по документам.
5. `lightrag_documents` (status=FAILED) — диагностика проблем.

## Тесты

```bash
cd /home/sa/work/dsh-lightrag
node test/mock-test.mjs
```

Самодостаточный тест: поднимает мок-сервер LightRAG (все REST-эндпоинты)
и прогоняет клиента и все 7 инструментов, включая авторизацию, опрос
прогресса и обработку ошибок.

## Используемый REST API сервера (совместимость)

```
GET    /health
POST   /query                       {query, mode, only_need_context?, response_type?, top_k?, user_prompt?, include_references?}
POST   /documents/text              {text, file_source?}                → {status, message, track_id}
POST   /documents/upload            multipart `file`                    → {status, message, track_id}
POST   /documents/paginated         {page, page_size, status_filter?, sort_field, sort_direction}
GET    /documents/pipeline_status
GET    /documents/track_status/{id}
DELETE /documents/delete_document   {doc_id, delete_file?}
```

Статусы документов: `PENDING | PREPROCESSED | PARSING | ANALYZING | PROCESSED | FAILED`.

## Структура

```
dsh-lightrag/
├── package.json        # метаданные, dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml    # слой патча: запись `lightrag` в дерево профиля
├── lib/index.js        # клиент LightRAG REST + 7 инструментов + apply(ctx, config)
├── test/mock-test.mjs  # тесты с мок-сервером
└── node_modules/       # dev-ссылки на dsh-tools/schemastery (не публикуются)
```
