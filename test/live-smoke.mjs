/**
 * Live smoke test against the real local LightRAG server (127.0.0.1:9621).
 * Ingests a small Russian test document, waits for indexing, asks a question.
 * Run: node test/live-smoke.mjs
 */
import { createLightragClient, buildTools } from "../lib/index.js";

const client = createLightragClient({ baseUrl: "http://127.0.0.1:9621", timeoutMs: 300000 });
const tools = Object.fromEntries(buildTools(client, { queryMode: "mix" }).map((t) => [t.name, t]));

const show = (label, v) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
};

show("status", await tools.lightrag_status.execute({}));

const text = `# Тестовый документ: регламент дежурного SRE

Компания «Ртк-СиДи» использует внутреннюю сеть rtk-cd.ru.
Дежурный SRE обязан проверять мониторинг каждые 15 минут.
При инциденте уровня P1 дежурный созывает war-room в течение 10 минут.
База знаний хранится в LightRAG, вопросы задаёт агент DeepSeek Harness.
Продолжительность дежурства — 12 часов, смена передаётся по чек-листу.`;

const ingest = await tools.lightrag_ingest_text.execute({ text, fileSource: "sre-oncall-policy.md" });
show("ingest", ingest);
if (ingest.status !== "success") throw new Error("ingest failed: " + ingest.message);

const track = await tools.lightrag_track.execute({ trackId: ingest.trackId, waitSeconds: 420 });
show("track", track);
if (!track.done) throw new Error("indexing did not finish in time");
if (track.statusSummary.FAILED) throw new Error("document failed: " + JSON.stringify(track.documents));

const answer = await tools.lightrag_query.execute({ query: "Как быстро дежурный SRE должен созвать war-room при P1-инциденте?" });
show("query", answer.content);
if (!/10 минут/.test(answer.content)) {
  console.log("\nWARNING: ответ не содержит ожидаемого факта — проверьте качество ниже.");
} else {
  console.log("\nOK: ответ содержит ожидаемый факт (10 минут).");
}
