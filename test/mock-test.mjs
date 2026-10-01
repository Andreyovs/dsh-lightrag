/**
 * Self-contained test: mock LightRAG server + dsh-lightrag client/tools.
 * Run: node test/mock-test.mjs
 */
import http from "node:http";
import assert from "node:assert";
import { createLightragClient, buildTools, apply, Config } from "../lib/index.js";

const seenHeaders = {};
let queryCalls = 0;
let trackCalls = 0;
let uploadFilenames = [];
let paginatedBodies = [];
let deleteBodies = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (obj, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    seenHeaders[req.url] = req.headers.authorization ?? null;
    try {
      if (req.method === "GET" && req.url === "/health") return json({ status: "healthy", version: "mock" });

      if (req.method === "POST" && req.url === "/query") {
        queryCalls++;
        const p = JSON.parse(body);
        if (p.query === "boom") return json({ detail: "mock 500" }, 500);
        return json({
          response: `mock answer to: ${p.query} (mode=${p.mode})`,
          references: [{ reference_id: "ref-1", file_path: "manual.md" }],
          llm_generated: !p.only_need_context,
        });
      }

      if (req.method === "POST" && req.url === "/documents/text") {
        const p = JSON.parse(body);
        return json({ status: "success", message: "Text successfully processed.", track_id: "text_track_1", file_source: p.file_source ?? null, len: p.text.length });
      }

      if (req.method === "POST" && req.url === "/documents/upload") {
        // multipart: just capture the filename from Content-Disposition
        const m = body.match(/filename="([^"]+)"/);
        uploadFilenames.push(m?.[1] ?? null);
        return json({ status: "success", message: "File uploaded.", track_id: "upload_track_1" });
      }

      if (req.method === "POST" && req.url === "/documents/paginated") {
        const p = JSON.parse(body);
        paginatedBodies.push(p);
        // mimic server 1.5.x: page_size 10..200, lowercase status_filter
        if ((p.page_size ?? 50) < 10 || (p.page_size ?? 50) > 200) return json({ detail: "page_size out of range" }, 422);
        if (p.status_filter && p.status_filter !== p.status_filter.toLowerCase()) return json({ detail: "status_filter must be lowercase" }, 422);
        return json({
          documents: [
            { id: "doc-1", file_path: "manual.md", status: "processed", updated_at: "2026-07-17T00:00:00Z", chunks_count: 3 },
            { id: "doc-2", file_path: "bad.pdf", status: "failed", updated_at: "2026-07-17T01:00:00Z", error_msg: "parse error" },
          ],
          pagination: { page: p.page, page_size: p.page_size, total_count: 2, total_pages: 1, has_next: false, has_prev: false },
          status_counts: { processed: 1, failed: 1 },
        });
      }

      if (req.method === "GET" && req.url === "/documents/pipeline_status") {
        return json({ busy: false, job_name: "", latest_message: "Idle" });
      }

      if (req.method === "GET" && req.url.startsWith("/documents/track_status/")) {
        trackCalls++;
        const trackId = decodeURIComponent(req.url.split("/").pop());
        // first poll: still parsing; second: done (server 1.5.x sends lowercase statuses)
        if (trackCalls === 1) {
          return json({ track_id: trackId, documents: [{ id: "doc-x", file_path: "a.md", status: "parsing" }], total_count: 1, status_summary: { parsing: 1 } });
        }
        return json({ track_id: trackId, documents: [{ id: "doc-x", file_path: "a.md", status: "processed" }], total_count: 1, status_summary: { processed: 1 } });
      }

      if (req.method === "DELETE" && req.url === "/documents/delete_document") {
        const p = JSON.parse(body);
        // server 1.5.x schema: doc_ids array (required)
        if (!Array.isArray(p.doc_ids) || p.doc_ids.length === 0) return json({ detail: "doc_ids required" }, 422);
        deleteBodies.push(p);
        return json({ status: "deletion_started", message: `deleting ${p.doc_ids.join(",")}${p.delete_file ? " (+file)" : ""}` });
      }

      json({ detail: "not found" }, 404);
    } catch (e) {
      json({ detail: String(e) }, 500);
    }
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const client = createLightragClient({ baseUrl, apiKey: "secret-key", timeoutMs: 5000 });
const cfg = { baseUrl, queryMode: "hybrid", timeoutMs: 5000 };
const tools = Object.fromEntries(buildTools(client, cfg).map((t) => [t.name, t]));

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

// --- lightrag_query ---
{
  const t = tools.lightrag_query;
  const out = await t.execute({ query: "Что такое LightRAG?" });
  assert.ok(out.content.includes("mock answer"));
  assert.strictEqual(out.mode, "hybrid"); // default from cfg
  assert.strictEqual(out.references[0].file, "manual.md");
  // dsh-tools >=0.1.2: finalizeContent receives a ToolExecutionResult envelope {isError, value}, not the raw value.
  // dsh 0.2.0 contract: output.render returns ContentBlock[] directly; finalizeContent is idempotent with it.
  assert.deepStrictEqual(t.finalizeContent(null, { isError: false, value: out }), t.output.render({ query: "x" }, out));
  ok("lightrag_query (default mode from config, references, finalize)");

  const out2 = await t.execute({ query: "q", mode: "naive", onlyNeedContext: true, topK: 25, responseType: "Bullet Points", userPrompt: "be brief" });
  assert.strictEqual(out2.mode, "naive");
  assert.strictEqual(out2.llmGenerated, false);
  ok("lightrag_query (explicit mode + flags)");

  await assert.rejects(() => t.execute({ query: "boom" }), /HTTP 500/);
  await assert.rejects(() => t.execute({}), /query/);
  await assert.rejects(() => t.execute({ query: "  " }), /query is required/);
  await assert.rejects(() => t.execute({ query: "x", mode: "bogus" }), /mode must be one of/);
  ok("lightrag_query (errors)");
}

// --- lightrag_ingest_text (durable route: temp file + upload endpoint) ---
{
  const t = tools.lightrag_ingest_text;
  const out = await t.execute({ text: "hello kb", fileSource: "note.md" });
  assert.strictEqual(out.status, "success");
  assert.strictEqual(out.trackId, "upload_track_1");
  assert.strictEqual(uploadFilenames.at(-1), "note.md");
  const out2 = await t.execute({ text: "[Unit]\nDescription=x", fileSource: "autostart/service.service" });
  assert.strictEqual(out2.trackId, "upload_track_1");
  assert.strictEqual(uploadFilenames.at(-1), "autostart-service.service.txt"); // unsupported ext → .txt
  ok("lightrag_ingest_text (upload route + filename sanitizing)");
}

// --- lightrag_ingest_file ---
{
  const t = tools.lightrag_ingest_file;
  const fs = await import("node:fs/promises");
  await fs.writeFile("/tmp/dsh-lightrag-upload-test.md", "file content", { mode: 0o600 }).catch(() => {});
  // /tmp may be unavailable; fall back to cwd
  let p = "/tmp/dsh-lightrag-upload-test.md";
  try {
    await fs.access(p);
  } catch {
    p = new URL("./upload-test.md", import.meta.url).pathname;
    await fs.writeFile(p, "file content");
  }
  const out = await t.execute({ filePath: p });
  assert.strictEqual(out.status, "success");
  assert.strictEqual(out.trackId, "upload_track_1");
  assert.strictEqual(uploadFilenames.at(-1), "dsh-lightrag-upload-test.md");
  const out2 = await t.execute({ filePath: p, fileSource: "custom-name.md" });
  assert.strictEqual(uploadFilenames.at(-1), "custom-name.md");
  const out3 = await t.execute({ filePath: p, fileSource: "lightrag/deploy.sh" });
  assert.strictEqual(uploadFilenames.at(-1), "lightrag-deploy.sh"); // '/' is unsafe for the server
  await assert.rejects(() => t.execute({ filePath: "/nonexistent/xyz.bin" }), /ENOENT/);
  ok("lightrag_ingest_file (upload + filename + slash sanitizing + error)");
}

// --- lightrag_track (polling: first PARSING, then PROCESSED) ---
{
  const t = tools.lightrag_track;
  const single = await t.execute({ trackId: "text_track_1" });
  assert.strictEqual(single.done, false);
  const waited = await t.execute({ trackId: "text_track_1", waitSeconds: 15 });
  assert.strictEqual(waited.done, true);
  assert.deepStrictEqual(waited.statusSummary, { processed: 1 });
  assert.strictEqual(waited.documents[0].status, "PROCESSED"); // plugin normalizes to uppercase
  ok("lightrag_track (single check + polling to terminal)");
}

// --- lightrag_status ---
{
  const t = tools.lightrag_status;
  const out = await t.execute({});
  assert.strictEqual(out.healthy, true);
  assert.strictEqual(out.pipelineBusy, false);
  assert.strictEqual(out.totalCount, 2);
  assert.deepStrictEqual(out.statusCounts, { processed: 1, failed: 1 });
  ok("lightrag_status");
}

// --- lightrag_documents ---
{
  const t = tools.lightrag_documents;
  const out = await t.execute({});
  assert.strictEqual(out.totalCount, 2);
  assert.strictEqual(out.documents[1].status, "FAILED");
  assert.strictEqual(out.documents[1].error, "parse error");
  const filtered = await t.execute({ status: "FAILED", pageSize: 500 }); // clamped to 200
  assert.deepStrictEqual(filtered.statusCounts, { processed: 1, failed: 1 });
  // server 1.5.x requires lowercase status_filter — plugin must normalize
  assert.strictEqual(paginatedBodies.at(-1).status_filter, "failed");
  ok("lightrag_documents (list + lowercase filter + clamp)");
}

// --- lightrag_delete_document ---
{
  const t = tools.lightrag_delete_document;
  const out = await t.execute({ documentId: "doc-2", deleteFile: true });
  assert.strictEqual(out.status, "deletion_started");
  assert.ok(out.message.includes("doc-2") && out.message.includes("+file"));
  // server 1.5.x schema: doc_ids array
  assert.deepStrictEqual(deleteBodies.at(-1).doc_ids, ["doc-2"]);
  assert.strictEqual(deleteBodies.at(-1).delete_file, true);
  ok("lightrag_delete_document (doc_ids body)");
}

// --- auth header ---
assert.strictEqual(seenHeaders["/health"], "Bearer secret-key");
ok("Authorization: Bearer header sent");

// --- client error when server unreachable ---
{
  const bad = createLightragClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
  await assert.rejects(() => bad.health(), /fetch failed|ECONNREFUSED|LightRAG GET \/health failed/);
  ok("unreachable server error");
}

// --- apply(): mock ctx, verify tool registration + prompt section + page routes ---
{
  const registered = [];
  const sections = [];
  const routes = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject: (names, fn) => {
      const sctx = {
        effect: (impl, label) => {
          registered.push(label);
          impl();
        },
        tools: { register: (tool) => registered.push(`tool:${tool.name}`) },
        systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
        webServer: { register: (route) => { routes.push(`${route.kind} ${route.path}`); return () => {}; } },
        subprocess: { resolveExecutable: async () => "/usr/bin/curl", spawn: () => { throw new Error("no subprocess in test"); } },
      };
      fn(sctx);
    },
  };
  apply(ctx, { baseUrl: "http://mock:1234", queryMode: "local" });
  const toolNames = registered.filter((r) => r.startsWith("tool:")).map((r) => r.slice(5));
  assert.deepStrictEqual(toolNames, [
    "lightrag_query",
    "lightrag_ingest_text",
    "lightrag_ingest_file",
    "lightrag_track",
    "lightrag_status",
    "lightrag_documents",
    "lightrag_delete_document",
  ]);
  assert.strictEqual(sections.length, 1);
  assert.ok(sections[0].text.includes("http://mock:1234"));
  assert.deepStrictEqual(routes, ["exact /lightrag-docs", "prefix /lightrag-docs/action"]);
  ok("apply() registers 7 tools + 1 prompt section + 2 page routes");

  const parsed = Config["~standard"].validate({}).value;
  assert.strictEqual(parsed.queryMode, "mix");
  assert.strictEqual(parsed.baseUrl, "http://127.0.0.1:9621");
  ok("Config schema defaults");
}

server.close();
console.log(`\nALL ${passed} TEST GROUPS PASSED (${queryCalls} query calls, ${trackCalls} track calls)`);
