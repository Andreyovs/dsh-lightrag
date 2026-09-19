/**
 * dsh-lightrag — LightRAG knowledge base plugin for DeepSeek Harness.
 *
 * Registers agent tools that talk to a LightRAG server
 * (https://lightrag.github.io/, github.com/HKUDS/LightRAG):
 *
 *   lightrag_query            — graph-RAG answer from the knowledge base
 *   lightrag_ingest_text      — add a raw text document (→ track_id)
 *   lightrag_ingest_file      — upload a file from the workspace (→ track_id)
 *   lightrag_track            — poll ingestion progress by track_id
 *   lightrag_status           — server health, pipeline state, doc counts
 *   lightrag_documents        — list documents with pagination/status filter
 *   lightrag_delete_document  — remove a document by id
 *
 * Server API used (current lightrag-server):
 *   GET  /health
 *   POST /query                        {query, mode, only_need_context?, response_type?, top_k?, user_prompt?, include_references?}
 *   POST /documents/text               {text, file_source?}
 *   POST /documents/upload             multipart `file`
 *   POST /documents/paginated          {page, page_size, status_filter?, sort_field, sort_direction}
 *   GET  /documents/pipeline_status
 *   GET  /documents/track_status/{id}
 *   DELETE /documents/delete_document  {doc_ids: [id], delete_file?}
 * Auth: `Authorization: Bearer <key>` when LIGHTRAG_API_KEY is set.
 *
 * Server 1.5.x notes:
 *   - /documents/paginated: page_size 10..200, status_filter values are
 *     lowercase (pending|parsing|analyzing|processing|preprocessed|processed|failed).
 *   - /documents/upload rejects filenames containing '/' ("Unsafe filename").
 *   - /documents/text can lose the doc_status record when another ingestion
 *     runs concurrently, so lightrag_ingest_text materializes the text as a
 *     temp file and uses the durable file-upload path instead.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const name = "lightrag";
const inject = ["tools"];

const QUERY_MODES = ["mix", "local", "global", "hybrid", "naive", "bypass"];
const DOC_STATUSES = ["PENDING", "PREPROCESSED", "PARSING", "ANALYZING", "PROCESSED", "FAILED"];
const TERMINAL_STATUSES = new Set(["PROCESSED", "FAILED"]);
const SORT_FIELDS = ["created_at", "updated_at", "id", "file_path"];

/**
 * File extensions accepted by lightrag-server /documents/upload (1.5.x).
 * Texts with other (or no) extension are uploaded as `.txt`.
 */
const SUPPORTED_UPLOAD_EXT = new Set([
  "bat", "c", "conf", "cpp", "css", "csv", "docx", "epub", "go", "h", "hpp",
  "htm", "html", "ini", "java", "js", "json", "less", "log", "md", "mdx",
  "odt", "pdf", "php", "pptx", "properties", "py", "rb", "rtf", "scss",
  "sh", "sql", "swift", "tex", "textpack", "ts", "txt", "xlsx", "xml", "yaml", "yml",
]);

/**
 * Make a name safe for the upload endpoint: no path separators, no control
 * chars, optional unsupported extension replaced with `.txt`.
 * @param {string} raw filename or virtual label
 * @returns {string}
 */
export function safeUploadName(raw) {
  const flat = String(raw).replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  const base = flat || "document";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext && SUPPORTED_UPLOAD_EXT.has(ext)) return base;
  return `${base || "document"}.txt`;
}

/** Default config schema (documented values; env vars override in the patch). */
export const Config = z.object({
  baseUrl: z.string().default("http://127.0.0.1:9621"),
  apiKey: z.string().default(""),
  queryMode: z.string().default("mix"),
  timeoutMs: z.number().default(180000),
});

// ---------------------------------------------------------------------------
// LightRAG HTTP client
// ---------------------------------------------------------------------------

/**
 * Build a LightRAG REST client.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.apiKey]
 * @param {number} [options.timeoutMs]
 * @param {(url: string, init: object) => Promise<Response>} [options.fetchImpl] override for tests
 */
export function createLightragClient({ baseUrl, apiKey = "", timeoutMs = 180000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");

  async function request(method, urlPath, { body, form } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let payload;
      if (form !== undefined) payload = form;
      else if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const res = await fetchImpl(base + urlPath, { method, headers, body: payload, signal: controller.signal });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const detail =
          json && typeof json.detail === "string" ? json.detail : json && (json.detail ?? json.error) ? JSON.stringify(json.detail ?? json.error) : "";
        throw new Error(
          `LightRAG ${method} ${urlPath} failed: HTTP ${res.status}${detail ? ` — ${detail}` : text ? ` — ${text.slice(0, 300)}` : ` — ${res.statusText}`}`
        );
      }
      return json ?? text;
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`LightRAG ${method} ${urlPath} timed out after ${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,
    health: () => request("GET", "/health"),
    pipelineStatus: () => request("GET", "/documents/pipeline_status"),
    trackStatus: (trackId) => request("GET", `/documents/track_status/${encodeURIComponent(trackId)}`),
    documents: (params) => request("POST", "/documents/paginated", { body: params }),
    query: (params) => request("POST", "/query", { body: params }),
    insertText: (text, fileSource) =>
      request("POST", "/documents/text", { body: { text, ...(fileSource ? { file_source: fileSource } : {}) } }),
    async uploadFile(filePath, fileSource) {
      const buf = await readFile(filePath);
      const form = new FormData();
      const fileName = safeUploadName(fileSource || path.basename(filePath));
      form.append("file", new Blob([buf]), fileName);
      return request("POST", "/documents/upload", { form });
    },
    deleteDocument: (docId, deleteFile = false) =>
      request("DELETE", "/documents/delete_document", { body: { doc_ids: [docId], ...(deleteFile ? { delete_file: true } : {}) } }),
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

const textBlock = (text) => [{ type: "text", text }];

/** Shared formatting for lightrag_query results (UI render + model-visible text). */
const formatQueryResult = (v) => {
  const refs = (v.references ?? [])
    .map((r) => `- ${r.file}${r.referenceId ? ` (${r.referenceId})` : ""}`)
    .join("\n");
  return `LightRAG query (${v.mode}${v.llmGenerated === false ? ", context only" : ""}):\n${v.content}${refs ? `\n\nSources:\n${refs}` : ""}`;
};

/**
 * Build the lightrag_* tool definitions for a given client.
 * @param {ReturnType<typeof createLightragClient>} client
 * @param {object} cfg resolved config ({baseUrl, queryMode, ...})
 * @returns {Array} defineTool definitions
 */
export function buildTools(client, cfg) {
  const tools = [];

  // --- lightrag_query -------------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_query",
      description:
        "Query the LightRAG knowledge base (graph RAG over ingested documents). Use it for questions about documents already added to the knowledge base. Returns the generated answer with source document references.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "The question to answer from the knowledge base.",
        },
        mode: {
          type: "string",
          description: `Retrieval mode: ${QUERY_MODES.join(" | ")}. Default: configured mode (usually "mix").`,
        },
        responseType: {
          type: "string",
          description: 'Optional answer format hint, e.g. "Multiple Paragraphs", "Single Paragraph", "Bullet Points".',
        },
        topK: {
          type: "number",
          description: "Optional retrieval depth (top_k).",
        },
        onlyNeedContext: {
          type: "boolean",
          description: "When true, return only the retrieved context without LLM answer generation.",
        },
        userPrompt: {
          type: "string",
          description: "Optional extra instruction for the answer generator.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "string", required: true },
            mode: { type: "string" },
            llmGenerated: { type: "boolean" },
            references: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  referenceId: { type: "string" },
                  file: { type: "string" },
                },
              },
            },
          },
        },
        render(_args, v) {
          return formatQueryResult(v);
        },
      },
      async execute(args) {
        if (!args.query || !String(args.query).trim()) throw new Error("query is required");
        const mode = args.mode ?? cfg.queryMode ?? "mix";
        if (!QUERY_MODES.includes(mode)) throw new Error(`mode must be one of: ${QUERY_MODES.join(", ")}`);
        const body = { query: String(args.query), mode, include_references: true };
        if (args.responseType) body.response_type = String(args.responseType);
        if (typeof args.topK === "number" && args.topK > 0) body.top_k = Math.floor(args.topK);
        if (args.onlyNeedContext) body.only_need_context = true;
        if (args.userPrompt) body.user_prompt = String(args.userPrompt);
        const res = await client.query(body);
        const content = typeof res?.response === "string" ? res.response : JSON.stringify(res ?? {});
        const references = Array.isArray(res?.references)
          ? res.references
              .map((r) => {
                const out = {};
                if (r?.reference_id) out.referenceId = String(r.reference_id);
                if (r?.file_path) out.file = String(r.file_path);
                return out;
              })
              .filter((r) => Object.keys(r).length > 0)
          : [];
        return { content, mode, llmGenerated: res?.llm_generated !== false, references };
      },
      finalizeContent(_exec, result) {
        return textBlock(formatQueryResult(result));
      },
    })
  );

  // --- lightrag_ingest_text ---------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_ingest_text",
      description:
        "Add a text document to the LightRAG knowledge base. The server chunks it and extracts entities/relations in the background; returns a track_id — check progress with lightrag_track.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "The full text content to add to the knowledge base.",
        },
        fileSource: {
          type: "string",
          description: "Optional virtual filename/label (e.g. 'manual-2026.md') used as the document identifier.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            message: { type: "string" },
            trackId: { type: "string" },
          },
        },
        render(_a, v) {
          return `Document submitted (status: ${v.status}${v.trackId ? `, track: ${v.trackId}` : ""})${v.message ? ` — ${v.message}` : ""}`;
        },
      },
      async execute(args) {
        if (!args.text || !String(args.text).trim()) throw new Error("text is required");
        const text = String(args.text);
        const label = args.fileSource ? String(args.fileSource) : `text-${Date.now()}.txt`;
        // Durable route: write the text to a temp file and use the file-upload
        // endpoint. On lightrag-server 1.5.x a concurrent /documents/text
        // insert can lose the doc_status record, while an uploaded file stays
        // in the server input dir and remains re-scannable.
        const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-lightrag-"));
        const fileName = safeUploadName(label);
        const tmp = path.join(dir, fileName);
        try {
          await writeFile(tmp, text, { mode: 0o600 });
          const res = await client.uploadFile(tmp, fileName);
          return { status: res.status, message: res.message, trackId: res.track_id };
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
      finalizeContent(_exec, result) {
        return textBlock(
          `Document submitted (status: ${result.status}${result.trackId ? `, track: ${result.trackId}` : ""})${result.message ? ` — ${result.message}` : ""}. Check progress with lightrag_track(trackId="${result.trackId ?? ""}").`
        );
      },
    })
  );

  // --- lightrag_ingest_file ---------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_ingest_file",
      description:
        "Upload a file from the workspace to the LightRAG knowledge base (server-side text extraction, then graph indexing in the background). Returns a track_id — check progress with lightrag_track.",
      parameters: {
        filePath: {
          type: "string",
          required: true,
          description: "Path of the file to ingest (absolute, or relative to the current workspace).",
        },
        fileSource: {
          type: "string",
          description: "Optional custom document identifier instead of the file name.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            message: { type: "string" },
            trackId: { type: "string" },
          },
        },
        render(_a, v) {
          return `File submitted (status: ${v.status}${v.trackId ? `, track: ${v.trackId}` : ""})${v.message ? ` — ${v.message}` : ""}`;
        },
      },
      async execute(args) {
        if (!args.filePath || !String(args.filePath).trim()) throw new Error("filePath is required");
        const abs = path.resolve(String(args.filePath));
        const res = await client.uploadFile(abs, args.fileSource ? String(args.fileSource) : undefined);
        return { status: res.status, message: res.message, trackId: res.track_id };
      },
      finalizeContent(_exec, result) {
        return textBlock(
          `File submitted (status: ${result.status}${result.trackId ? `, track: ${result.trackId}` : ""})${result.message ? ` — ${result.message}` : ""}. Check progress with lightrag_track(trackId="${result.trackId ?? ""}").`
        );
      },
    })
  );

  // --- lightrag_track ---------------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_track",
      description:
        "Check ingestion progress for a track_id returned by lightrag_ingest_text / lightrag_ingest_file. Optionally polls until all documents reach a terminal state (PROCESSED/FAILED).",
      parameters: {
        trackId: {
          type: "string",
          required: true,
          description: "The track_id returned by an ingest call.",
        },
        waitSeconds: {
          type: "number",
          description: "Optional: poll up to N seconds (default 0 = single check, max 600).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            trackId: { type: "string", required: true },
            totalCount: { type: "number" },
            statusSummary: { type: "object", additionalProperties: true },
            done: { type: "boolean" },
            documents: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  file: { type: "string" },
                  status: { type: "string" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
        render(_a, v) {
          const lines = (v.documents ?? [])
            .map((d) => `- ${d.file || d.id}: ${d.status}${d.error ? ` — ${d.error}` : ""}`)
            .join("\n");
          return `Track ${v.trackId}: ${v.done ? "done" : "in progress"} (total ${v.totalCount}).\n${lines || "(no documents)"}`;
        },
      },
      async execute(args) {
        if (!args.trackId || !String(args.trackId).trim()) throw new Error("trackId is required");
        const waitMs = Math.max(0, Math.min(args.waitSeconds ?? 0, 600)) * 1000;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let snapshot = await client.trackStatus(String(args.trackId));
        const allTerminal = (snap) =>
          Array.isArray(snap.documents) &&
          snap.documents.length > 0 &&
          snap.documents.every((d) => TERMINAL_STATUSES.has(String(d?.status ?? "").toUpperCase()));
        const deadline = Date.now() + waitMs;
        while (!allTerminal(snapshot) && Date.now() < deadline) {
          await sleep(3000);
          snapshot = await client.trackStatus(String(args.trackId));
        }
        const documents = (snapshot.documents ?? []).map((d) => {
          const out = {};
          if (d?.id) out.id = String(d.id);
          if (d?.file_path) out.file = String(d.file_path);
          if (d?.status) out.status = String(d.status).toUpperCase();
          if (d?.error_msg) out.error = String(d.error_msg);
          return out;
        });
        return {
          trackId: snapshot.track_id ?? String(args.trackId),
          totalCount: snapshot.total_count ?? documents.length,
          statusSummary: snapshot.status_summary ?? {},
          done: allTerminal(snapshot),
          documents,
        };
      },
      finalizeContent(_exec, result) {
        const lines = (result.documents ?? [])
          .map((d) => `- ${d.file || d.id}: ${d.status}${d.error ? ` — ${d.error}` : ""}`)
          .join("\n");
        return textBlock(`Track ${result.trackId}: ${result.done ? "done" : "still in progress"} (total ${result.totalCount}).\n${lines || "(no documents yet)"}`);
      },
    })
  );

  // --- lightrag_status --------------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_status",
      description:
        "Check the LightRAG server: health, indexing pipeline state and document counts by status. Use before ingesting or when a query fails.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            healthy: { type: "boolean", required: true },
            serverError: { type: "string" },
            pipelineBusy: { type: "boolean" },
            jobName: { type: "string" },
            latestMessage: { type: "string" },
            totalCount: { type: "number" },
            statusCounts: { type: "object", additionalProperties: true },
          },
        },
        render(_a, v) {
          const counts = Object.entries(v.statusCounts ?? {})
            .map(([k, n]) => `${k}=${n}`)
            .join(", ");
          return `LightRAG ${v.healthy ? "healthy" : "UNREACHABLE"}${v.serverError ? ` (${v.serverError})` : ""}; pipeline ${v.pipelineBusy ? "busy" : "idle"}${v.jobName ? ` [${v.jobName}]` : ""}; documents: ${v.totalCount ?? "?"}${counts ? ` (${counts})` : ""}${v.latestMessage ? `\nLatest: ${v.latestMessage}` : ""}`;
        },
      },
      async execute() {
        const [health, pipeline, docs] = await Promise.allSettled([
          client.health(),
          client.pipelineStatus(),
          client.documents({ page: 1, page_size: 10, sort_field: "updated_at", sort_direction: "desc" }),
        ]);
        const result = { healthy: false, statusCounts: {} };
        if (health.status === "fulfilled") {
          result.healthy = health.value?.status === "healthy" || health.value?.status === "ok" || true;
        } else {
          result.healthy = false;
          result.serverError = String(health.reason?.message ?? health.reason).slice(0, 300);
        }
        if (pipeline.status === "fulfilled") {
          const p = pipeline.value ?? {};
          result.pipelineBusy = !!p.busy;
          if (p.job_name) result.jobName = String(p.job_name);
          if (p.latest_message) result.latestMessage = String(p.latest_message);
        }
        if (docs.status === "fulfilled") {
          const d = docs.value ?? {};
          result.totalCount = d.pagination?.total_count ?? 0;
          result.statusCounts = d.status_counts ?? {};
        }
        return result;
      },
      finalizeContent(_exec, result) {
        const counts = Object.entries(result.statusCounts ?? {})
          .map(([k, n]) => `${k}=${n}`)
          .join(", ");
        return textBlock(
          `LightRAG ${result.healthy ? "healthy" : "UNREACHABLE"}${result.serverError ? ` (${result.serverError})` : ""}; pipeline ${result.pipelineBusy ? "busy" : "idle"}${result.jobName ? ` [${result.jobName}]` : ""}; documents: ${result.totalCount ?? "?"}${counts ? ` (${counts})` : ""}${result.latestMessage ? `\nLatest: ${result.latestMessage}` : ""}`
        );
      },
    })
  );

  // --- lightrag_documents -----------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_documents",
      description: `List documents in the LightRAG knowledge base with pagination and status filter. Use to see what is ingested and find failed documents (status ${DOC_STATUSES.join("|")}).`,
      parameters: {
        page: { type: "number", description: "Page number, 1-based. Default 1." },
        pageSize: { type: "number", description: "Items per page (server range 10–200). Default 50." },
        status: { type: "string", description: `Optional status filter: ${DOC_STATUSES.join(" | ")}.` },
        sortField: { type: "string", description: `Sort field: ${SORT_FIELDS.join(" | ")}. Default updated_at.` },
        sortDirection: { type: "string", description: "asc or desc. Default desc." },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            documents: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  file: { type: "string" },
                  status: { type: "string" },
                  updatedAt: { type: "string" },
                  chunks: { type: "number" },
                  error: { type: "string" },
                },
              },
            },
            totalCount: { type: "number" },
            totalPages: { type: "number" },
            statusCounts: { type: "object", additionalProperties: true },
          },
        },
        render(_a, v) {
          const lines = (v.documents ?? [])
            .map((d) => `- ${d.file || d.id}: ${d.status}${d.chunks !== undefined ? ` (${d.chunks} chunks)` : ""}${d.error ? ` — ${d.error}` : ""}`)
            .join("\n");
          const counts = Object.entries(v.statusCounts ?? {})
            .map(([k, n]) => `${k}=${n}`)
            .join(", ");
          return `Documents (total ${v.totalCount}${counts ? `, ${counts}` : ""}):\n${lines || "(none)"}`;
        },
      },
      async execute(args) {
        const body = {
          page: Math.max(1, Math.floor(args.page ?? 1)),
          page_size: Math.max(10, Math.min(200, Math.floor(args.pageSize ?? 50))),
          sort_field: SORT_FIELDS.includes(args.sortField) ? args.sortField : "updated_at",
          sort_direction: args.sortDirection === "asc" ? "asc" : "desc",
        };
        if (args.status) body.status_filter = String(args.status).toLowerCase();
        const res = await client.documents(body);
        const documents = (res.documents ?? []).map((d) => {
          const out = {};
          if (d?.id) out.id = String(d.id);
          if (d?.file_path) out.file = String(d.file_path);
          if (d?.status) out.status = String(d.status).toUpperCase();
          if (d?.updated_at) out.updatedAt = String(d.updated_at);
          if (d?.chunks_count !== undefined) out.chunks = d.chunks_count;
          if (d?.error_msg) out.error = String(d.error_msg);
          return out;
        });
        return {
          documents,
          totalCount: res.pagination?.total_count ?? documents.length,
          totalPages: res.pagination?.total_pages ?? 1,
          statusCounts: res.status_counts ?? {},
        };
      },
      finalizeContent(_exec, result) {
        const lines = (result.documents ?? [])
          .map((d) => `- ${d.file || d.id}: ${d.status}${d.chunks !== undefined ? ` (${d.chunks} chunks)` : ""}${d.error ? ` — ${d.error}` : ""}`)
          .join("\n");
        const counts = Object.entries(result.statusCounts ?? {})
          .map(([k, n]) => `${k}=${n}`)
          .join(", ");
        return textBlock(`Documents (total ${result.totalCount}${counts ? `, ${counts}` : ""}):\n${lines || "(none)"}`);
      },
    })
  );

  // --- lightrag_delete_document ------------------------------------------------
  tools.push(
    defineTool({
      name: "lightrag_delete_document",
      description:
        "Delete a document from the LightRAG knowledge base with all its chunks, vectors and graph data. Irreversible — confirm with the user before deleting.",
      parameters: {
        documentId: {
          type: "string",
          required: true,
          description: "Document id (from lightrag_documents) to delete.",
        },
        deleteFile: {
          type: "boolean",
          description: "Also delete the stored source file. Default false.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            message: { type: "string" },
          },
        },
        render(_a, v) {
          return `Delete: ${v.status}${v.message ? ` — ${v.message}` : ""}`;
        },
      },
      async execute(args) {
        if (!args.documentId || !String(args.documentId).trim()) throw new Error("documentId is required");
        const res = await client.deleteDocument(String(args.documentId), !!args.deleteFile);
        return { status: res.status, message: res.message };
      },
      finalizeContent(_exec, result) {
        return textBlock(`Delete: ${result.status}${result.message ? ` — ${result.message}` : ""}`);
      },
    })
  );

  return tools;
}

// ---------------------------------------------------------------------------
// Browser page: /lightrag-docs (SSR document browser on the dsh web server)
// ---------------------------------------------------------------------------

/**
 * Build the two route handlers for the LightRAG documents page.
 * Server-side rendered HTML (auto-refresh via meta tag); the host proxies the
 * LightRAG API through a curl subprocess so the page has no CORS problems.
 *
 * @param {object} subprocess harness `subprocess` service
 * @param {string} baseUrl LightRAG server base URL
 * @returns {{pageHandler: Function, actionHandler: Function}}
 */
export function createLightragDocsPage(subprocess, baseUrl) {
  const BASE = String(baseUrl).replace(/\/+$/, "");
  let cachedCurl;

  async function curlPath() {
    if (cachedCurl) return cachedCurl;
    try {
      cachedCurl = await subprocess.resolveExecutable("curl");
    } catch {
      cachedCurl = "/usr/bin/curl";
    }
    return cachedCurl;
  }

  async function apiCall(method, path, body, rawArgs = []) {
    const argv = [await curlPath(), "-s", "-m", "120", "-X", method, BASE + path];
    if (body !== undefined) argv.push("-H", "Content-Type: application/json", "--data", JSON.stringify(body));
    if (rawArgs.length > 0) argv.push(...rawArgs);
    const handle = subprocess.spawn({
      argv,
      cwd: "/",
      stdio: { stdin: "ignore", stdout: { maxBytes: 4000000 }, stderr: { maxBytes: 100000 } },
      graceMs: 30000,
    });
    const outcome = await handle.done;
    const out = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null;
    const text = out && out.text ? out.text : "";
    if (outcome.exitCode !== 0 || !text) {
      const errOut = handle.collected && handle.collected.stderr ? (handle.collected.stderr.readFrom(0) || {}).text : "";
      throw new Error("LightRAG API error (exit " + outcome.exitCode + "): " + String(errOut || text || "no output").slice(0, 200));
    }
    return JSON.parse(text);
  }

  const esc = (s) => String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const qsDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  const parseQuery = (u) => {
    const out = {};
    const i = u.indexOf("?");
    if (i === -1) return out;
    for (const p of u.slice(i + 1).split("&")) {
      if (!p) continue;
      const eq = p.indexOf("=");
      if (eq === -1) out[p] = ""; else out[p.slice(0, eq)] = qsDecode(p.slice(eq + 1));
    }
    return out;
  };
  const readBody = (req, limit = 10000) => new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(data));
  });

  /** Filename safe for /documents/upload: no separators, no control chars. */
  const safeUploadName = (raw) =>
    String(raw).replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "upload";

  /** Live upload allowlist from the server (cached ~2 min). */
  let supportedCache = { at: 0, list: [] };
  async function supportedExts() {
    if (Date.now() - supportedCache.at < 120000 && supportedCache.list.length > 0) return supportedCache.list;
    try {
      const r = await apiCall("GET", "/documents/supported_file_types");
      supportedCache = { at: Date.now(), list: (r && r.supported_extensions || []).map((e) => String(e).toLowerCase()) };
    } catch {
      supportedCache = { at: Date.now(), list: [".md", ".txt", ".pdf", ".csv", ".json", ".html", ".log", ".xml", ".yaml", ".yml", ".sh", ".py", ".js", ".ts", ".bat", ".conf", ".ini", ".properties", ".tex", ".rtf", ".odt", ".docx", ".epub", ".pptx", ".xlsx"] };
    }
    return supportedCache.list;
  }
  const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

  const STATUS_ORDER = ["pending", "parsing", "analyzing", "processing", "preprocessed", "processed", "failed"];
  const STATUS_RU = { pending: "очередь", parsing: "парсинг", analyzing: "анализ", processing: "обработка", preprocessed: "предобработка", processed: "готово", failed: "ошибка" };
  const statusBadge = (s) => {
    const v = String(s || "").toLowerCase();
    const cls = v === "processed" ? "ok" : v === "failed" ? "bad" : "work";
    return `<span class="st ${cls}">${esc(STATUS_RU[v] || v)}</span>`;
  };

  async function renderPage(req, res) {
    const query = parseQuery(req.url || "/");
    const page = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), 1000);
    const status = typeof query.status === "string" && query.status ? query.status.toLowerCase() : "";
    const q = typeof query.q === "string" ? query.q.trim() : "";

    let docsRes = { error: "LightRAG недоступен" };
    let counts = {};
    let pipeline = {};
    try { docsRes = await apiCall("POST", "/documents/paginated", { page, page_size: 50, sort_field: "updated_at", sort_direction: "desc" }); }
    catch (e) { docsRes = { error: String(e.message || e) }; }
    try { const sc = (await apiCall("GET", "/documents/status_counts")) || {}; counts = sc.status_counts || sc; }
    catch { counts = {}; }
    try { pipeline = (await apiCall("GET", "/documents/pipeline_status")) || {}; }
    catch { pipeline = {}; }

    let documents = (docsRes && docsRes.documents) || [];
    const pagination = (docsRes && docsRes.pagination) || {};
    const total = pagination.total_count || documents.length;
    const totalPages = pagination.total_pages || Math.ceil(total / 50) || 1;
    if (q) {
      const needle = q.toLowerCase();
      documents = documents.filter((d) => String(d.file_path || "").toLowerCase().includes(needle));
    }

    const chips = [`<a class="chip${!status ? " on" : ""}" href="/lightrag-docs${q ? "?q=" + encodeURIComponent(q) : ""}">все: ${esc(total)}</a>`];
    for (const s of STATUS_ORDER) {
      const n = counts[s];
      if (n === undefined || n === 0) continue;
      chips.push(`<a class="chip${status === s ? " on" : ""}" href="/lightrag-docs?status=${s}${q ? "&q=" + encodeURIComponent(q) : ""}${page > 1 ? "&page=" + page : ""}">${esc(STATUS_RU[s] || s)}: ${esc(n)}</a>`);
    }

    const rows = [];
    for (const d of documents) {
      const fid = String(d.id || "");
      const summary = String(d.content_summary || "").replace(/\s+/g, " ").slice(0, 180);
      const delForm = fid.startsWith("doc-")
        ? `<form method="post" action="/lightrag-docs/action" onsubmit="return confirm('Удалить документ?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="doc_id" value="${esc(fid)}"><button class="del" type="submit">✕</button></form>`
        : "";
      rows.push(`<tr><td class="file" title="${esc(summary)}">${esc(d.file_path || "(без имени)")}</td><td>${statusBadge(d.status)}</td><td class="num">${esc(d.content_length === undefined ? "" : d.content_length)}</td><td class="dim">${esc(String(d.updated_at || "").slice(0, 16).replace("T", " "))}</td><td class="dim mono" title="${esc(fid)}">${esc(fid.slice(0, 14) + "…")}</td><td>${delForm}</td></tr>`);
    }

    const pipelineBanner = pipeline.busy
      ? `<div class="banner busy">⚙️ Пайплайн занят: ${esc(pipeline.job_name || "")} — ${esc(pipeline.latest_message || "")}</div>`
      : "";
    const errorBanner = docsRes.error ? `<div class="banner bad">⚠️ ${esc(docsRes.error)}</div>` : "";
    const noticeBanner = query.uploaded
      ? `<div class="banner ok">✅ Загружено: ${esc(query.uploaded)} — обработка в фоне, статус появится в таблице</div>`
      : query.removed === "all"
        ? `<div class="banner ok">🗑 Все документы удалены (кэш __parsed__ сохранён)</div>`
        : query.removed
          ? `<div class="banner ok">🗑 Документ удалён: ${esc(query.removed)}…</div>`
          : query.error
            ? `<div class="banner bad">⚠️ Ошибка: ${esc(query.error)}</div>`
            : "";
    const navBase = `/lightrag-docs?status=${status}${q ? "&q=" + encodeURIComponent(q) : ""}`;
    const prev = page > 1 ? `<a href="${navBase}&page=${page - 1}">← пред.</a>` : '<span class="dim">← пред.</span>';
    const next = page < totalPages ? `<a href="${navBase}&page=${page + 1}">след. →</a>` : '<span class="dim">след. →</span>';

    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="15"><title>LightRAG — документы</title><style>
body{background:#0e1116;color:#d7dce3;font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px}
h1{font-size:18px;margin:0 0 4px} h1 a{color:#7fb4ff;text-decoration:none}
.sub{color:#8b94a3;font-size:12px;margin-bottom:16px}
.chips{margin:12px 0} .chip{display:inline-block;padding:3px 10px;margin:2px 4px 2px 0;border-radius:12px;background:#1a2130;color:#aeb8c8;text-decoration:none;font-size:13px}
.chip.on{background:#2d5da8;color:#fff} .chip:hover{background:#243049}
.banner{padding:8px 12px;border-radius:8px;margin:10px 0;font-size:13px}
.banner.busy{background:#2a2410;color:#e8d48a} .banner.bad{background:#3a1519;color:#f0a3ad} .banner.ok{background:#12351f;color:#6fd394}
.actions{display:flex;gap:14px;align-items:center;margin:12px 0;flex-wrap:wrap}
.filepick{background:#1a2130;border:1px solid #2a3346;color:#aeb8c8;padding:4px 8px;border-radius:8px;max-width:320px}
button.danger{background:none;border:1px solid #7a2733;color:#f0a3ad;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px}
button.danger:hover{background:#3a1519}
table{width:100%;border-collapse:collapse;margin-top:10px}
th{color:#8b94a3;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;border-bottom:1px solid #232b3a}
td{padding:7px 8px;border-bottom:1px solid #1a2130;vertical-align:middle}
.file{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:#6b7686} .mono{font-family:ui-monospace,monospace;font-size:12px}
.st{padding:2px 8px;border-radius:10px;font-size:12px}
.st.ok{background:#12351f;color:#6fd394} .st.bad{background:#3a1519;color:#f0a3ad} .st.work{background:#2a2410;color:#e8d48a}
.del{background:none;border:1px solid #3a4356;border-radius:6px;color:#8b94a3;cursor:pointer;padding:2px 8px}
.del:hover{background:#3a1519;color:#f0a3ad}
.nav{margin:14px 0;display:flex;gap:14px;align-items:center} .nav a{color:#7fb4ff;text-decoration:none}
form.filter{display:flex;gap:8px;margin:10px 0}
input[type=text]{background:#1a2130;border:1px solid #2a3346;color:#d7dce3;padding:6px 10px;border-radius:8px;width:260px}
button.go{background:#2d5da8;border:none;color:#fff;padding:6px 14px;border-radius:8px;cursor:pointer}
</style></head><body>
<h1>📚 LightRAG — документы <a href="/" title="Назад в DSH">← DSH</a></h1>
<div class="sub">сервер: ${esc(BASE)} · автообновление каждые 15 с · всего: ${esc(total)}</div>
${pipelineBanner}${errorBanner}${noticeBanner}
<div class="chips">${chips.join("")}</div>
<div class="actions">
<form method="post" action="/lightrag-docs/action" id="uploadForm"><input type="hidden" name="action" value="upload"><input type="hidden" name="filename" id="fileName" value=""><input type="hidden" name="b64" id="fileB64" value=""><input type="file" id="filePick" class="filepick"><button class="go" type="button" id="uploadBtn">📤 Загрузить документ</button></form>
<form method="post" action="/lightrag-docs/action" id="delAllForm"><input type="hidden" name="action" value="delete_all"><input type="hidden" name="confirm" id="delAllConfirm" value=""><button class="danger" type="button" id="delAllBtn">🗑 Удалить все документы</button></form>
</div>
<form class="filter" method="get" action="/lightrag-docs">${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ""}<input type="text" name="q" value="${esc(q)}" placeholder="фильтр по имени…"><button class="go" type="submit">Найти</button></form>
<table><thead><tr><th>Файл</th><th>Статус</th><th class="num">Размер, Б</th><th>Обновлено</th><th>ID</th><th></th></tr></thead>
<tbody>${rows.join("") || '<tr><td colspan="6" class="dim">документы не найдены</td></tr>'}</tbody></table>
<div class="nav">${prev}<span>стр. ${esc(page)} / ${esc(totalPages)}</span>${next}</div>
<script>
(function () {
  var pick = document.getElementById("filePick");
  var fN = document.getElementById("fileName");
  var fB = document.getElementById("fileB64");
  var upBtn = document.getElementById("uploadBtn");
  pick.addEventListener("change", function () {
    var f = pick.files && pick.files[0];
    if (!f) { fN.value = ""; fB.value = ""; return; }
    if (f.size > 20 * 1024 * 1024) { alert("Файл больше 20 МБ — выберите файл поменьше"); pick.value = ""; fN.value = ""; fB.value = ""; return; }
    var r = new FileReader();
    r.onload = function () { fN.value = f.name; fB.value = String(r.result).split(",").pop(); };
    r.onerror = function () { alert("Не удалось прочитать файл"); };
    r.readAsDataURL(f);
  });
  upBtn.addEventListener("click", function () {
    if (!fB.value) { alert("Сначала выберите файл"); return; }
    document.getElementById("uploadForm").submit();
  });
  document.getElementById("delAllBtn").addEventListener("click", function () {
    var t = prompt("Удалить ВСЕ документы из базы знаний (безвозвратно, кэш __parsed__ сохранится)?\\nВведите УДАЛИТЬ для подтверждения:");
    if (t === "УДАЛИТЬ") {
      document.getElementById("delAllConfirm").value = "yes";
      document.getElementById("delAllForm").submit();
    }
  });
})();
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  async function handleAction(req, res) {
    let reply = "400 bad request";
    let status = 400;
    if (req.method === "POST") {
      // 40 MB covers a 25 MB file base64-encoded in the form body.
      const data = await readBody(req, 40 * 1024 * 1024);
      const params = {};
      for (const p of data.split("&")) {
        if (!p) continue;
        const eq = p.indexOf("=");
        if (eq === -1) params[p] = ""; else params[p.slice(0, eq)] = qsDecode(p.slice(eq + 1));
      }
      const docId = String(params.doc_id || "");

      if (params.action === "delete" && /^doc-[A-Za-z0-9]{16,64}$/.test(docId)) {
        try {
          await apiCall("DELETE", "/documents/delete_document", { doc_ids: [docId] });
          status = 303;
          reply = `/lightrag-docs?removed=${docId.slice(0, 14)}`;
        } catch (e) {
          status = 303;
          reply = `/lightrag-docs?error=${encodeURIComponent(String(e.message || e).slice(0, 120))}`;
        }
      } else if (params.action === "delete_all" && params.confirm === "yes") {
        // DELETE /documents: drops all documents/entities/files; __parsed__ cache
        // is preserved (delete_parsed_files defaults to false).
        try {
          await apiCall("DELETE", "/documents");
          status = 303;
          reply = "/lightrag-docs?removed=all";
        } catch (e) {
          status = 303;
          reply = `/lightrag-docs?error=${encodeURIComponent(String(e.message || e).slice(0, 120))}`;
        }
      } else if (params.action === "upload") {
        const name = safeUploadName(String(params.filename || ""));
        const b64 = String(params.b64 || "");
        const fail = (msg) => { status = 303; reply = `/lightrag-docs?error=${encodeURIComponent(msg)}`; };
        if (!name || !b64) {
          fail("Файл не выбран или пуст");
        } else {
          const buf = Buffer.from(b64, "base64");
          if (buf.length === 0) {
            fail("Не удалось декодировать файл");
          } else if (buf.length > MAX_UPLOAD_BYTES) {
            fail(`Файл больше ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ`);
          } else {
            const dot = name.lastIndexOf(".");
            const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
            const allowed = await supportedExts();
            if (ext && !allowed.includes(ext)) {
              fail(`Расширение ${ext} не поддерживается сервером LightRAG (допустимые: ${allowed.slice(0, 12).join(" ")} …)`);
            } else if (!ext) {
              fail("У файла нет расширения — добавьте расширение из списка поддерживаемых");
            } else {
              const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-lightrag-up-"));
              const tmp = path.join(dir, name);
              try {
                await writeFile(tmp, buf, { mode: 0o600 });
                const r = await apiCall("POST", "/documents/upload", undefined, ["-F", `file=@${tmp};filename=${name}`]);
                status = 303;
                reply = r && r.status === "success"
                  ? `/lightrag-docs?uploaded=${encodeURIComponent(name)}`
                  : `/lightrag-docs?error=${encodeURIComponent(String((r && (r.detail || r.message)) || "upload failed").slice(0, 120))}`;
              } catch (e) {
                fail(String(e.message || e).slice(0, 120));
              } finally {
                await rm(dir, { recursive: true, force: true }).catch(() => {});
              }
            }
          }
        }
      }
    }
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...(status === 303 ? { Location: reply } : {}) });
    res.end(status === 303 ? "" : reply);
  }

  const failSafe = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("lightrag-docs error: " + String(e && e.message || e));
    });

  return {
    pageHandler: failSafe(renderPage),
    actionHandler: failSafe(handleAction),
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Plugin entry: register the lightrag_* tools and a system-prompt section.
 * @param {object} ctx harness plugin context
 * @param {object} [config] entry config from the patch tree
 */
export function apply(ctx, config) {
  const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  const cfg = {
    baseUrl: config?.baseUrl ?? process.env.LIGHTRAG_BASE_URL ?? "http://127.0.0.1:9621",
    apiKey: config?.apiKey ?? process.env.LIGHTRAG_API_KEY ?? "",
    queryMode: config?.queryMode ?? "mix",
    timeoutMs: num(config?.timeoutMs, 180000),
  };
  const logger = ctx.logger;
  const client = createLightragClient(cfg);

  for (const tool of buildTools(client, cfg)) {
    ctx.inject(["tools"], (sctx) =>
      sctx.effect(
        () => {
          const dispose = sctx.tools.register(tool);
          return () => dispose();
        },
        `lightrag: ${tool.name} tool`
      )
    );
  }

  ctx.inject(["webServer", "subprocess"], (sctx) =>
    sctx.effect(
      () => {
        const disposes = [];
        try {
          const { pageHandler, actionHandler } = createLightragDocsPage(sctx.subprocess, cfg.baseUrl);
          disposes.push(sctx.webServer.register({ kind: "exact", path: "/lightrag-docs", handler: pageHandler }));
          disposes.push(sctx.webServer.register({ kind: "prefix", path: "/lightrag-docs/action", handler: actionHandler }));
        } catch (e) {
          // Never let a route-registration failure take the plugin (or boot) down.
          ctx.logger?.error?.(`lightrag: /lightrag-docs route registration failed: ${e?.message ?? e}`);
        }
        return () => {
          for (const dispose of disposes) {
            try { dispose(); } catch { /* already removed */ }
          }
        };
      },
      "lightrag: /lightrag-docs page routes"
    )
  );

  ctx.inject(["systemPrompt"], (sctx) =>
    sctx.effect(
      () => {
        const dispose = sctx.systemPrompt.section({
          name: "lightrag:kb",
          order: 500,
          text: [
            "## LightRAG knowledge base",
            `A LightRAG knowledge-base server is available at ${cfg.baseUrl}. It holds documents the user asked to work with.`,
            "- lightrag_query — answer questions from the knowledge base (graph RAG). Prefer it over web_search for questions about already-ingested documents.",
            "- lightrag_ingest_text / lightrag_ingest_file — add documents to the knowledge base (returns a track_id).",
            "- lightrag_track — check ingestion progress for a track_id.",
            "- lightrag_status — server health, indexing pipeline state and document counts.",
            "- lightrag_documents — list ingested documents with their statuses.",
            "- lightrag_delete_document — remove a document by id (irreversible).",
            "Workflow: ingest first (lightrag_ingest_*), poll with lightrag_track until done, then answer with lightrag_query.",
            "The user can browse the knowledge base in the browser at http://127.0.0.1:3080/lightrag-docs (document list, status filters, delete).",
          ].join("\n"),
        });
        return () => {
          if (dispose) dispose();
        };
      },
      "lightrag: knowledge base prompt section"
    )
  );

  logger?.info?.(`lightrag: plugin registered (server: ${cfg.baseUrl}, query mode: ${cfg.queryMode})`);
}

export { name, inject };
