#!/usr/bin/env bash
# =============================================================================
# failover-start.sh — идемпотентный запуск LLM failover-прокси для LightRAG.
#
# Прокси: 127.0.0.1:8901, OpenAI-совместимый /v1/chat/completions.
#   primary: https://gpustack.rtk-cd.ru/v1 (LLM_BINDING_API_KEY из ../.env)
#   backup:  http://192.168.60.200:8001/v1 (RedHatAI/Qwen3.6-35B-A3B-NVFP4)
#
# Идемпотентен: если /health уже отвечает — ничего не запускает.
# =============================================================================
set -u

HOST=127.0.0.1
PORT="${FAILOVER_PORT:-8901}"
ROOT="${LIGHTRAG_ROOT:-/home/sa/automation/lightrag}"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/failover-proxy.log"
WAIT_SECONDS=30

health_up() {
  curl -s -o /dev/null -m 2 "http://$HOST:$PORT/health"
}

main() {
  if health_up; then
    echo "LLM failover-прокси уже запущен: http://$HOST:$PORT/health — ничего не запускаю."
    return 0
  fi

  [[ -x "$ROOT/.venv/bin/python" ]] || { echo "ОШИБКА: venv не найден: $ROOT/.venv" >&2; return 1; }
  mkdir -p "$LOG_DIR"
  cd "$ROOT" || return 1
  setsid nohup "$ROOT/.venv/bin/python" failover/llm_failover_proxy.py >> "$LOG_FILE" 2>&1 < /dev/null &

  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if health_up; then
      echo "LLM failover-прокси запущен: http://$HOST:$PORT (лог: $LOG_FILE)"
      return 0
    fi
    sleep 1
  done

  echo "ОШИБКА: прокси не поднял /health за ${WAIT_SECONDS}s. См. $LOG_FILE" >&2
  return 1
}

main "$@"
