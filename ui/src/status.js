// Служебные функции для статусов документов.

export const WORKING_STATUSES = new Set([
  "PENDING",
  "PREPROCESSED",
  "PARSING",
  "ANALYZING",
  "PROCESSING",
]);

export function isWorkingStatus(status) {
  return WORKING_STATUSES.has((status || "").toUpperCase());
}

export function isFailed(status) {
  return (status || "").toUpperCase() === "FAILED";
}

export function isProcessed(status) {
  return (status || "").toUpperCase() === "PROCESSED";
}

/** CSS-класс бейджа по статусу. */
export function statusBadgeClass(status) {
  const u = (status || "").toUpperCase();
  if (u === "PROCESSED") return "badge processed";
  if (u === "FAILED") return "badge failed";
  if (u === "PENDING") return "badge pending";
  if (WORKING_STATUSES.has(u)) return "badge working";
  return "badge";
}

/**
 * statusCounts из /status может иметь ключи в любом регистре —
 * нормализуем в верхний.
 */
export function normalizeStatusCounts(counts) {
  const out = {};
  for (const [k, v] of Object.entries(counts || {})) {
    const u = String(k).toUpperCase();
    out[u] = (out[u] ?? 0) + Number(v || 0);
  }
  return out;
}

/** Модификатор цвета для чипа в шапке. */
export function chipClass(status) {
  const u = (status || "").toUpperCase();
  if (u === "PROCESSED") return "ok";
  if (u === "FAILED") return "bad";
  if (isWorkingStatus(u)) return "busy";
  return "";
}
