/**
 * dsh-lightrag — web UI routes (served inside the DSH GUI web server, :3080).
 *
 *   GET /lightrag-docs          — built React SPA (ui/dist), SPA fallback to index.html
 *   /api/lightrag-docs/...      — JSON/multipart proxy to the LightRAG server:
 *       GET  /status            health + pipeline + counts
 *       GET  /documents?status&limit
 *       POST /upload            multipart passthrough (field `file`)
 *       POST /text              {text, fileSource}
 *       POST /delete            {documentId, deleteFile}
 *       POST /reprocess         reprocess all FAILED documents
 *       GET  /track/{trackId}
 *
 * All routes accept loopback requests only (like the dsh-free-search bridge).
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_ROOT = fileURLToPath(new URL("../ui/dist", import.meta.url));
const UI_PREFIX = "/lightrag-docs";
const API_PREFIX = "/api/lightrag-docs";
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["PROCESSED", "FAILED"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function isLoopback(req) {
  const a = req.socket?.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function writeJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  try {
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (buf.length === 0) return {};
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Static SPA server
// ---------------------------------------------------------------------------

async function handleUi(req, res) {
  if (!isLoopback(req)) return writeJson(res, 403, { error: "loopback requests only" });
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    return writeJson(res, 400, { error: "bad path" });
  }
  if (!pathname.startsWith(UI_PREFIX)) return writeJson(res, 404, { error: "not found" });
  let rel = pathname.slice(UI_PREFIX.length) || "/";
  if (rel === "/" || rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(UI_ROOT, rel));
  if (file !== UI_ROOT && !file.startsWith(UI_ROOT + path.sep)) return writeJson(res, 403, { error: "forbidden" });
  try {
    const st = await stat(file);
    if (st.isDirectory()) throw new Error("dir");
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    // SPA fallback: unknown non-asset paths serve index.html; a missing
    // index.html itself means "UI not built" (503), a missing asset is 404.
    const isIndex = file === path.join(UI_ROOT, "index.html");
    if (!isIndex && path.extname(file).length > 1) return writeJson(res, 404, { error: "not found" });
    try {
      const index = await readFile(path.join(UI_ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(index);
    } catch {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("dsh-lightrag: UI не собран. Выполните `npm run build` в kите (ui/dist отсутствует).");
    }
  }
}

// ---------------------------------------------------------------------------
// API proxy
// ---------------------------------------------------------------------------

function mapDocument(d) {
  const out = {};
  if (d?.id) out.id = String(d.id);
  if (d?.file_path) out.file = String(d.file_path);
  if (d?.status) out.status = String(d.status).toUpperCase();
  if (d?.created_at) out.createdAt = String(d.created_at);
  if (d?.updated_at) out.updatedAt = String(d.updated_at);
  if (d?.track_id) out.trackId = String(d.track_id);
  if (d?.chunks_count !== undefined) out.chunks = d.chunks_count;
  if (d?.content_length !== undefined) out.contentLength = d.content_length;
  if (d?.content_summary) out.contentSummary = String(d.content_summary);
  if (d?.error_msg) out.error = String(d.error_msg);
  return out;
}

async function fetchAllDocuments(client, { status, limit = 500 }) {
  const docs = [];
  let page = 1;
  while (docs.length < limit) {
    const res = await client.documents({
      page,
      page_size: 200,
      sort_field: "updated_at",
      sort_direction: "desc",
      ...(status ? { status_filter: status } : {}),
    });
    const batch = res.documents ?? [];
    docs.push(...batch);
    const total = res.pagination?.total_count ?? docs.length;
    if (docs.length >= total || batch.length === 0) break;
    page += 1;
    if (page > 25) break; // защита от бесконечного цикла
  }
  return docs.slice(0, limit);
}

async function handleApi(client, req, res) {
  if (!isLoopback(req)) return writeJson(res, 403, { error: "loopback requests only" });
  const url = new URL(req.url, "http://x");
  const sub = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  const fail = (code, message) => writeJson(res, code, { ok: false, error: message });

  try {
    if (sub === "/status" && method === "GET") {
      const [health, pipeline, docs] = await Promise.allSettled([
        client.health(),
        client.pipelineStatus(),
        client.documents({ page: 1, page_size: 10, sort_field: "updated_at", sort_direction: "desc" }),
      ]);
      const out = { ok: true, healthy: false, statusCounts: {} };
      if (health.status === "fulfilled") out.healthy = true;
      else {
        out.healthy = false;
        out.serverError = String(health.reason?.message ?? health.reason).slice(0, 300);
      }
      if (pipeline.status === "fulfilled") {
        const p = pipeline.value ?? {};
        out.pipelineBusy = !!p.busy;
        if (p.job_name && p.job_name !== "-") out.jobName = String(p.job_name);
        if (p.latest_message) out.latestMessage = String(p.latest_message);
      }
      if (docs.status === "fulfilled") {
        const d = docs.value ?? {};
        out.totalCount = d.pagination?.total_count ?? 0;
        out.statusCounts = d.status_counts ?? {};
      }
      return writeJson(res, 200, out);
    }

    if (sub === "/documents" && method === "GET") {
      const status = url.searchParams.get("status")?.toUpperCase() ?? undefined;
      const limit = Math.max(10, Math.min(2000, Number(url.searchParams.get("limit") ?? 500)));
      const docs = (await fetchAllDocuments(client, { status, limit })).map(mapDocument);
      return writeJson(res, 200, { ok: true, documents: docs });
    }

    if (sub === "/upload" && method === "POST") {
      const contentType = req.headers["content-type"];
      if (!contentType || !contentType.toLowerCase().includes("multipart/form-data")) {
        return fail(400, "expected multipart/form-data with field `file`");
      }
      const buf = await readBody(req);
      const out = await client.rawPost("/documents/upload", buf, contentType);
      return writeJson(res, 200, { ok: true, status: out.status, message: out.message, trackId: out.track_id });
    }

    if (sub === "/text" && method === "POST") {
      const body = await readJsonBody(req);
      if (body === undefined) return fail(400, "malformed JSON body");
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) return fail(400, "text is required");
      const out = await client.insertText(text, body.fileSource ? String(body.fileSource) : undefined);
      return writeJson(res, 200, { ok: true, status: out.status, message: out.message, trackId: out.track_id });
    }

    if (sub === "/delete" && method === "POST") {
      const body = await readJsonBody(req);
      if (body === undefined) return fail(400, "malformed JSON body");
      const id = typeof body.documentId === "string" ? body.documentId : "";
      if (!id.trim()) return fail(400, "documentId is required");
      const out = await client.deleteDocument(id, !!body.deleteFile);
      return writeJson(res, 200, { ok: true, status: out.status, message: out.message });
    }

    if (sub === "/reprocess" && method === "POST") {
      const out = await client.reprocessFailed();
      return writeJson(res, 200, { ok: true, status: out.status, message: out.message });
    }

    if (sub.startsWith("/track/") && method === "GET") {
      const trackId = decodeURIComponent(sub.slice("/track/".length));
      if (!trackId) return fail(400, "trackId is required");
      const snap = await client.trackStatus(trackId);
      const documents = (snap.documents ?? []).map(mapDocument);
      const done =
        documents.length > 0 && documents.every((d) => TERMINAL_STATUSES.has(d.status ?? ""));
      return writeJson(res, 200, {
        ok: true,
        trackId: snap.track_id ?? trackId,
        totalCount: snap.total_count ?? documents.length,
        statusSummary: snap.status_summary ?? {},
        done,
        documents,
      });
    }

    return fail(404, `unknown API route: ${method} ${sub}`);
  } catch (err) {
    const code = err?.code === 413 ? 413 : 502;
    return fail(code, String(err?.message ?? err));
  }
}

/**
 * Build the web-server route objects for the LightRAG docs UI.
 * @param {object} client lightrag client (createLightragClient)
 * @returns {Array<{kind: "prefix", path: string, handler: Function}>}
 */
export function createWebUiRoutes(client) {
  return [
    { kind: "prefix", path: API_PREFIX, handler: (req, res) => handleApi(client, req, res) },
    { kind: "prefix", path: UI_PREFIX, handler: handleUi },
  ];
}
