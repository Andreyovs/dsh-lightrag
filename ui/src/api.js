// Клиент API LightRAG (базовый путь /api/lightrag-docs).
// Все ошибки бросаются как Error с текстом из {error} или HTTP-статусом.

const API_BASE = "/api/lightrag-docs";

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, options);
  } catch {
    throw new Error("Нет соединения с сервером");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ответ не JSON */
  }

  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && (data.error || data.message)) || `Ошибка сервера (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}

const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function getStatus() {
  return request("/status");
}

export function getDocuments({ status, limit = 500 } = {}) {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  q.set("limit", String(limit));
  return request(`/documents?${q.toString()}`);
}

export function uploadFiles(files) {
  const fd = new FormData();
  for (const f of files) fd.append("file", f);
  return request("/upload", { method: "POST", body: fd });
}

export function addText(text, fileSource) {
  return request("/text", json({ text, fileSource: fileSource || undefined }));
}

export function deleteDocument(documentId, deleteFile) {
  return request("/delete", json({ documentId, deleteFile: Boolean(deleteFile) }));
}

export function reprocessAll() {
  return request("/reprocess", json({}));
}

export function getTrack(trackId) {
  return request(`/track/${encodeURIComponent(trackId)}`);
}
