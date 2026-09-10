/** Тосты успеха/ошибок — правый верхний угол, автоскрытие в App. */
export default function Toasts({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={t.type === "error" ? "toast error" : "toast success"}
        >
          <span className="toast-msg">{t.message}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onDismiss(t.id)}
            aria-label="Скрыть уведомление"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
