import { isFailed, statusBadgeClass } from "../status";

/**
 * Панель «Недавние загрузки»: список trackId со статусами.
 * Пока done=false — документы с бейджами; при done — «готово» / «ошибка».
 */
export default function TrackPanel({ tracks }) {
  return (
    <section className="card">
      <h2 className="card-title">Недавние загрузки</h2>
      {tracks.length === 0 ? (
        <p className="empty small">Загрузок пока нет</p>
      ) : (
        <ul className="track-list">
          {tracks.map((t) => {
            const docs = Array.isArray(t.documents) ? t.documents : [];
            const failedCount =
              Number(t.statusSummary?.FAILED ?? t.statusSummary?.failed ?? 0) +
              0;
            const hasFailed =
              failedCount > 0 || docs.some((d) => isFailed(d.status));
            return (
              <li key={t.trackId} className="track">
                <div className="track-head">
                  <code className="track-id" title={t.trackId}>
                    {t.trackId}
                  </code>
                  {t.done ? (
                    hasFailed ? (
                      <span className="track-state bad">ошибка</span>
                    ) : (
                      <span className="track-state ok">✓ готово</span>
                    )
                  ) : (
                    <span className="track-state busy">в работе…</span>
                  )}
                </div>
                {!t.done && docs.length > 0 && (
                  <div className="track-docs">
                    {docs.map((d, i) => (
                      <span
                        key={d.id || i}
                        className={statusBadgeClass(d.status)}
                        title={d.file || d.error || d.status}
                      >
                        {(d.status || "?").toUpperCase()}
                      </span>
                    ))}
                  </div>
                )}
                {!t.done && t.latestMessage && (
                  <p className="muted small">{t.latestMessage}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
