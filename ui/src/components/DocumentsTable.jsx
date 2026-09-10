import { useMemo, useState } from "react";
import { isFailed, isWorkingStatus, statusBadgeClass } from "../status";
import { fmtTime } from "../util";

const STATUS_FILTERS = [
  { value: "all", label: "Все" },
  { value: "PROCESSED", label: "PROCESSED" },
  { value: "FAILED", label: "FAILED" },
  { value: "PENDING", label: "PENDING" },
  { value: "working", label: "в работе" },
];

/**
 * Таблица документов: фильтры (поиск по имени файла, статус),
 * колонки Файл / Статус / Чанки / Обновлён / Действия.
 */
export default function DocumentsTable({
  documents,
  loading,
  refreshing,
  onCard,
  onRetry,
  onDelete,
  onRefresh,
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return documents.filter((d) => {
      const st = (d.status || "").toUpperCase();
      if (statusFilter === "working") {
        if (!isWorkingStatus(st)) return false;
      } else if (statusFilter !== "all") {
        if (st !== statusFilter) return false;
      }
      if (
        q &&
        !(d.file || "").toLowerCase().includes(q) &&
        !(d.id || "").toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [documents, search, statusFilter]);

  return (
    <section className="card table-card">
      <div className="table-toolbar">
        <h2 className="card-title inline">
          Документы <span className="muted">({documents.length})</span>
        </h2>
        <input
          type="search"
          className="search"
          placeholder="Поиск по имени файла…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Фильтр по статусу"
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={onRefresh}
          disabled={refreshing || loading}
        >
          {refreshing ? "Обновление…" : "Обновить"}
        </button>
      </div>

      {loading ? (
        <p className="empty">Загрузка…</p>
      ) : filtered.length === 0 ? (
        <p className="empty">
          {documents.length === 0
            ? "Документов пока нет — загрузите файлы или добавьте текст"
            : "Ничего не найдено по заданным фильтрам"}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                <th>Файл</th>
                <th>Статус</th>
                <th className="num">Чанки</th>
                <th>Обновлён</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id}>
                  <td className="file-cell" title={d.file}>
                    {d.file || "—"}
                  </td>
                  <td>
                    <span className={statusBadgeClass(d.status)}>
                      {(d.status || "—").toUpperCase()}
                    </span>
                  </td>
                  <td className="num">{d.chunks ?? "—"}</td>
                  <td className="mono nowrap">{fmtTime(d.updatedAt)}</td>
                  <td className="actions">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => onCard(d)}
                    >
                      Карточка
                    </button>
                    {isFailed(d.status) && (
                      <button
                        type="button"
                        className="btn small"
                        onClick={onRetry}
                      >
                        Повторить
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn small danger"
                      onClick={() => onDelete(d)}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
