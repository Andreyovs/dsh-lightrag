#!/usr/bin/env python3
"""LLM failover proxy для LightRAG (OpenAI-совместимый).

Маршрутизация /v1/chat/completions:
  1. PRIMARY  (по умолчанию https://gpustack.rtk-cd.ru/v1, ключ клиента пересылается как есть)
  2. BACKUP   (по умолчанию http://192.168.60.200:8001/v1, model переписывается в
     FAILOVER_BACKUP_MODEL) — при connect-error, таймауте, 408/429/5xx ДО первого байта ответа.

Cooldown: после сбоя primary новые запросы идут сразу в backup; фоновый сондаж
GET {primary}/models каждые 20 c возвращает трафик на primary.

Запуск (из venv LightRAG):
  .venv/bin/python failover/llm_failover_proxy.py
  log -> logs/failover-proxy.log   (см. failover/failover-start.sh)

Переменные окружения:
  FAILOVER_PORT              порт (127.0.0.1), по умолчанию 8901
  FAILOVER_PRIMARY_URL       по умолчанию https://gpustack.rtk-cd.ru/v1
  FAILOVER_BACKUP_URL        по умолчанию http://192.168.60.200:8001/v1
  FAILOVER_BACKUP_MODEL      по умолчанию RedHatAI/Qwen3.6-35B-A3B-NVFP4
  FAILOVER_PRIMARY_DEADLINE  секунд на ответ primary (по умолчанию 300)
  FAILOVER_BACKUP_DEADLINE   секунд на ответ backup (по умолчанию 280)
  FAILOVER_CONNECT_TIMEOUT   секунд на TCP-connect (по умолчанию 15)
  FAILOVER_COOLDOWN          секунд cooldown primary после сбоя (по умолчанию 60)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("failover")

PRIMARY_URL = os.environ.get("FAILOVER_PRIMARY_URL", "https://gpustack.rtk-cd.ru/v1").rstrip("/")
BACKUP_URL = os.environ.get("FAILOVER_BACKUP_URL", "http://192.168.60.200:8001/v1").rstrip("/")
BACKUP_MODEL = os.environ.get("FAILOVER_BACKUP_MODEL", "RedHatAI/Qwen3.6-35B-A3B-NVFP4")
PRIMARY_DEADLINE = float(os.environ.get("FAILOVER_PRIMARY_DEADLINE", "300"))
BACKUP_DEADLINE = float(os.environ.get("FAILOVER_BACKUP_DEADLINE", "280"))
CONNECT_TIMEOUT = float(os.environ.get("FAILOVER_CONNECT_TIMEOUT", "15"))
COOLDOWN = float(os.environ.get("FAILOVER_COOLDOWN", "60"))

RETRY_STATUS = {408, 429, 500, 502, 503, 504}

state = {
    "primary_url": PRIMARY_URL,
    "backup_url": BACKUP_URL,
    "primary_cooldown_until": 0.0,
    "primary_last_error": None,
    "backup_last_error": None,
    "routed_primary": 0,
    "routed_backup": 0,
    "failovers": 0,
}


def _deadline_pool(deadline: float) -> httpx.Timeout:
    # connect — короткий (мёртвый бэкенд ловим быстро), read/write — до дедлайна
    return httpx.Timeout(deadline, connect=CONNECT_TIMEOUT)


def _client_headers(req: Request, for_backup: bool) -> dict:
    h = {"Content-Type": "application/json"}
    auth = req.headers.get("authorization")
    if not for_backup or not auth:
        if auth:
            h["Authorization"] = auth  # primary: ключ клиента пересылаем как есть
    return h


def _rewrite_model(body: bytes, model: str | None) -> bytes:
    if model is None:
        return body
    try:
        data = json.loads(body)
        if isinstance(data, dict) and "model" in data:
            data["model"] = model
            return json.dumps(data, ensure_ascii=False).encode("utf-8")
    except Exception:  # не-JSON — не трогаем
        pass
    return body


async def _probe_primary() -> None:
    """Фоновый сондаж primary каждые 20 c, пока он в cooldown."""
    while True:
        await asyncio.sleep(20)
        if time.time() >= state["primary_cooldown_until"]:
            continue
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=CONNECT_TIMEOUT)) as c:
                r = await c.get(f"{PRIMARY_URL}/models",
                                headers={"Authorization": "Bearer probe"})
            if r.status_code == 200:
                state["primary_cooldown_until"] = 0.0
                state["primary_last_error"] = None
                log.info("primary восстановился: %s", PRIMARY_URL)
        except Exception as e:
            log.debug("primary ещё недоступен: %s", e)


def _mark_primary_down(err: str) -> None:
    state["primary_last_error"] = err
    state["primary_cooldown_until"] = time.time() + COOLDOWN
    log.warning("primary недоступен (%s) -> backup на %.0f c", err, COOLDOWN)


app = FastAPI(title="lightrag-llm-failover")


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_probe_primary())
    log.info("failover proxy: primary=%s backup=%s (model->%s)",
             PRIMARY_URL, BACKUP_URL, BACKUP_MODEL)


async def _attempt(req: Request, body: bytes, is_backup: bool):
    """Одна попытка. Возвращает (response, failover: bool, reason: str|None)."""
    url = (BACKUP_URL if is_backup else PRIMARY_URL) + "/chat/completions"
    headers = _client_headers(req, is_backup)
    deadline = BACKUP_DEADLINE if is_backup else PRIMARY_DEADLINE
    payload = _rewrite_model(body, BACKUP_MODEL if is_backup else None)
    is_stream = False
    try:
        data = json.loads(body)
        is_stream = bool(data.get("stream")) if isinstance(data, dict) else False
    except Exception:
        pass

    client = httpx.AsyncClient(timeout=_deadline_pool(deadline),
                               verify=False if url.startswith("https") else True)
    t0 = time.time()
    if not is_stream:
        r = await client.post(url, content=payload, headers=headers)
        await client.aclose()
        dt = time.time() - t0
        if r.status_code in RETRY_STATUS:
            reason = f"HTTP {r.status_code}"
            r.read()
            return None, True, reason
        log.info("%s: HTTP %s за %.1fs, %d байт",
                 "backup" if is_backup else "primary", r.status_code, dt, len(r.content))
        return (JSONResponse(status_code=r.status_code, content=r.json()), False, None)

    # streaming
    stream_ctx = client.stream("POST", url, content=payload, headers=headers)
    try:
        r = await stream_ctx.__aenter__()
    except Exception:
        await stream_ctx.__aexit__(None, None, None)
        raise
    if r.status_code in RETRY_STATUS:
        await stream_ctx.__aexit__(None, None, None)
        return None, True, f"HTTP {r.status_code}"
    first_byte = asyncio.Event()

    async def _gen():
        try:
            async for chunk in r.aiter_bytes():
                if not first_byte.is_set():
                    first_byte.set()
                    log.info("%s: stream первый байт за %.1fs",
                             "backup" if is_backup else "primary", time.time() - t0)
                yield chunk
        except Exception as e:
            if not first_byte.is_set():
                raise  # до первого байта — допускаем failover
            log.error("stream оборван: %s", e)
            yield b'data: {"error":"stream interrupted"}\n\n'
        finally:
            try:
                await r.aclose()
            except Exception:
                pass
            await client.aclose()

    return (StreamingResponse(_gen(), media_type=r.headers.get("content-type",
          "text/event-stream")), False, None)


async def _chat(req: Request):
    try:
        body = await req.body()
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": f"bad request: {e}"})

    try:
        data = json.loads(body)
        model = data.get("model") if isinstance(data, dict) else None
    except Exception:
        model = None
    log.info("запрос: model=%s", model)

    primary_down = time.time() < state["primary_cooldown_until"]
    order = [(True, "backup-приоритет")] if primary_down else [(False, "primary"), (True, "backup")]

    last_reason = None
    for is_backup, why in order:
        if len(order) == 2:
            if not is_backup:
                state["routed_primary"] += 1
            else:
                state["routed_backup"] += 1
                if not primary_down:
                    state["failovers"] += 1
                    _mark_primary_down(last_reason or "unknown")
        try:
            resp, failover, reason = await _attempt(req, body, is_backup)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as e:
            failover, reason = True, type(e).__name__
            resp = None
        except (httpx.ReadTimeout, httpx.WriteTimeout) as e:
            failover, reason = True, f"{type(e).__name__}"
            resp = None
        except httpx.HTTPError as e:
            failover, reason = True, type(e).__name__
            resp = None
        if not failover or resp is not None:
            if resp is not None:
                return resp
            break
        last_reason = reason
        if not is_backup:
            continue
        # backup тоже не справился
        state["backup_last_error"] = reason
        break

    if last_reason:
        state["backup_last_error"] = last_reason
        log.error("оба бэкенда недоступны: primary=%s", last_reason)
    return JSONResponse(
        status_code=503,
        content={"error": {"message": f"LLM failover: все бэкенды недоступны ({last_reason})",
                           "type": "failover_exhausted"}})


@app.post("/v1/chat/completions")
async def chat_completions(req: Request):
    return await _chat(req)


@app.get("/v1/models")
async def models():
    out = {"object": "list", "data": []}
    for url in (PRIMARY_URL, BACKUP_URL):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=CONNECT_TIMEOUT),
                                         verify=url.startswith("https") is False) as c:
                r = await c.get(f"{url}/models")
                if r.status_code == 200:
                    for m in r.json().get("data", []):
                        out["data"].append({**m, "id": f"{m['id']}@{url.rsplit('/', 1)[-2]}"})
        except Exception as e:
            log.debug("models %s: %s", url, e)
    return out


@app.get("/health")
async def health():
    return {
        "ok": True,
        "primary": {
            "url": PRIMARY_URL,
            "cooldown": time.time() < state["primary_cooldown_until"],
            "cooldown_remaining": max(0.0, state["primary_cooldown_until"] - time.time()),
            "last_error": state["primary_last_error"],
        },
        "backup": {"url": BACKUP_URL, "model": BACKUP_MODEL,
                   "last_error": state["backup_last_error"]},
        "counters": {k: v for k, v in state.items() if k.startswith("routed") or k == "failovers"},
    }


def main() -> None:
    import uvicorn
    port = int(os.environ.get("FAILOVER_PORT", "8901"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
