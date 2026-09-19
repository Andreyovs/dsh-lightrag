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
- Бейндж занятого пайплайна, баннеры (загружено/удалено/ошибка),
  автообновление каждые 15 с.

Все обращения к LightRAG-серверу идут со стороны хоста (curl из процесса dsh) —
CORS не нужен. Страница переживает перезапуск dsh web (часть плагина профиля).

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
export LIGHTRAG_BASE_URL="http://192.168.1.50:9621"
```

### Локальная установка сервера (выполнена)

Сервер развёрнут в WSL из GitHub (HKUDS/LightRAG, ветка main, `[api]`),
каталог `/home/sa/andrey/work/lightrag`:

```bash
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python "git+https://github.com/HKUDS/LightRAG.git[api]"
lightrag-server   # конфиг в /home/sa/andrey/work/lightrag/.env
```

Текущая конфигурация (`.env`): LLM `RedHatAI/Qwen3.6-35B-A3B-NVFP4` через
gpustack `http://192.168.60.200:8001/v1` (openai-binding), эмбеддинги
`bge-m3:latest` (1024 мер) через Ollama `http://192.168.60.200:11434/v1`,
`LLM_TIMEOUT=600`, `EMBEDDING_TIMEOUT=300`, `MAX_PARALLEL_INSERT=1`,
`SUMMARY_LANGUAGE=Russian`, хранилища — JSON/NanoVectorDB/NetworkX в
`/home/sa/andrey/work/lightrag/rag_storage`.

> Замечание: извлечение сущностей идёт через LLM — время зависит от загрузки
> машины с моделями (Ollama-машина общая: возможны swap-задержки).
> Для больших документов заложите время или уменьшите параллелизм/чанки.

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

## Структура

```
dsh-lightrag/
├── package.json        # метаданные, dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml    # слой патча: запись `lightrag` в дерево профиля
├── lib/index.js        # клиент LightRAG REST + 7 инструментов + SSR-страница /lightrag-docs + apply(ctx, config)
├── test/mock-test.mjs  # тесты с мок-сервером
└── node_modules/       # dev-ссылки на dsh-tools/schemastery (не публикуются)
```
