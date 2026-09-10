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
 *   DELETE /documents/delete_document  {doc_id, delete_file?}
 * Auth: `Authorization: Bearer <key>` when LIGHTRAG_API_KEY is set.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWebUiRoutes } from "./web-ui.js";

const name = "lightrag";
const inject = ["tools", "webServer"];

const QUERY_MODES = ["mix", "local", "global", "hybrid", "naive", "bypass"];
const DOC_STATUSES = ["PENDING", "PREPROCESSED", "PARSING", "ANALYZING", "PROCESSED", "FAILED"];
const TERMINAL_STATUSES = new Set(["PROCESSED", "FAILED"]);
const SORT_FIELDS = ["created_at", "updated_at", "id", "file_path"];

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

  async function request(method, urlPath, { body, form, raw, extraHeaders = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...extraHeaders };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let payload;
      if (raw !== undefined) payload = raw;
      else if (form !== undefined) payload = form;
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
      form.append("file", new Blob([buf]), fileSource || path.basename(filePath));
      return request("POST", "/documents/upload", { form });
    },
    deleteDocument: (docId, deleteFile = false) =>
      request("DELETE", "/documents/delete_document", { body: { doc_id: docId, ...(deleteFile ? { delete_file: true } : {}) } }),
    reprocessFailed: () => request("POST", "/documents/reprocess_failed", { body: {} }),
    /** Passthrough of a raw multipart buffer to LightRAG (web UI upload). */
    rawPost: (urlPath, buffer, contentType) =>
      request("POST", urlPath, { raw: buffer, extraHeaders: { "Content-Type": contentType } }),
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
        const res = await client.insertText(String(args.text), args.fileSource ? String(args.fileSource) : undefined);
        return { status: res.status, message: res.message, trackId: res.track_id };
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
        if (args.status) body.status_filter = String(args.status).toUpperCase();
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

  // Web UI: SPA (ui/dist) + API-прокси внутри веб-сервера DSH GUI (:3080)
  ctx.inject(["webServer"], (sctx) =>
    sctx.effect(
      () => {
        const routes = createWebUiRoutes(client);
        const disposes = routes.map((route) => sctx.webServer.register(route));
        return () => disposes.forEach((d) => d());
      },
      "lightrag: docs web ui routes"
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
