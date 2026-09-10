import { chipClass, normalizeStatusCounts } from "../status";

/** «документ» / «документа» / «документов» по числу. */
function plural(n) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return "документов";
  if (d === 1) return "документ";
  if (d >= 2 && d <= 4) return "документа";
  return "документов";
}

/**
 * Шапка: индикатор сервера, пульс «индексация…»,
 * общее число документов и разбивка по статусам.
 */
export default function Header({ status }) {
  const counts = normalizeStatusCounts(status?.statusCounts);
  const total = Number(status?.totalCount) || 0;
  const hasStatus = Boolean(status);
  const healthy = hasStatus && status.healthy === true;
  const busy = hasStatus && status.pipelineBusy === true;

  let dotClass = "dot";
  let serverText = "Нет соединения с сервером";
  if (hasStatus) {
    if (healthy) {
      dotClass = "dot ok";
      serverText = "Сервер доступен";
    } else {
      dotClass = "dot bad";
      serverText = status.serverError
        ? `Сервер недоступен: ${status.serverError}`
        : "Сервер недоступен";
    }
  }

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="title">LightRAG — база знаний</h1>
        <div className="status-row">
          <span className={dotClass} aria-hidden="true" />
          <span className="server-text">{serverText}</span>
          {busy && (
            <span className="pulse-badge" title={status.latestMessage || ""}>
              индексация…
              {status.jobName ? ` (${status.jobName})` : ""}
            </span>
          )}
          {busy && status.latestMessage && (
            <span className="muted latest">{status.latestMessage}</span>
          )}
        </div>
      </div>
      <div className="header-right">
        <span className="total">
          {total} <span className="muted">{plural(total)}</span>
        </span>
        {Object.keys(counts).length > 0 && (
          <div className="chips">
            {Object.entries(counts).map(([k, v]) => (
              <span key={k} className={`chip ${chipClass(k)}`}>
                {k}: {v}
              </span>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
