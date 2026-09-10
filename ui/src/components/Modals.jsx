import { useState } from "react";
import { statusBadgeClass } from "../status";
import { fmtTime } from "../util";

/** Обёртка модального окна с затемнением фона. */
function Overlay({ children, onClose }) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {children}
    </div>
  );
}

/** Диалог удаления: подтверждение + чекбокс «также удалить исходный файл». */
export function DeleteModal({ doc, onCancel, onConfirm }) {
  const [deleteFile, setDeleteFile] = useState(false);
  return (
    <Overlay onClose={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Удаление документа">
        <h2 className="modal-title">Удаление документа</h2>
        <p>
          Удалить документ <strong>{doc.file || doc.id}</strong>?
          <br />
          <span className="muted">Действие нельзя отменить.</span>
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={deleteFile}
            onChange={(e) => setDeleteFile(e.target.checked)}
          />
          также удалить исходный файл
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Отмена
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => onConfirm(deleteFile)}
          >
            Удалить
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/** Подтверждение повторной обработки всех FAILED-документов. */
export function ReprocessModal({ onCancel, onConfirm }) {
  return (
    <Overlay onClose={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Повторная обработка">
        <h2 className="modal-title">Повторная обработка</h2>
        <p>
          Будут повторно обработаны <strong>все</strong> документы со статусом{" "}
          <code>FAILED</code>. Продолжить?
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="btn primary" onClick={onConfirm}>
            Переработать
          </button>
        </div>
      </div>
    </Overlay>
  );
}

/** Карточка документа: все поля. */
export function DocumentCardModal({ doc, onClose }) {
  return (
    <Overlay onClose={onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="Карточка документа"
      >
        <div className="modal-head">
          <h2 className="modal-title">Карточка документа</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>
        <dl className="doc-card">
          <div>
            <dt>ID</dt>
            <dd className="mono break">{doc.id ?? "—"}</dd>
          </div>
          <div>
            <dt>Файл</dt>
            <dd className="break">{doc.file || "—"}</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>
              <span className={statusBadgeClass(doc.status)}>
                {(doc.status || "—").toUpperCase()}
              </span>
            </dd>
          </div>
          <div>
            <dt>Создан</dt>
            <dd className="mono">{fmtTime(doc.createdAt)}</dd>
          </div>
          <div>
            <dt>Обновлён</dt>
            <dd className="mono">{fmtTime(doc.updatedAt)}</dd>
          </div>
          <div>
            <dt>Track ID</dt>
            <dd className="mono break">{doc.trackId || "—"}</dd>
          </div>
          <div>
            <dt>Чанки</dt>
            <dd>{doc.chunks ?? "—"}</dd>
          </div>
          <div>
            <dt>Длина контента</dt>
            <dd>{doc.contentLength ?? "—"}</dd>
          </div>
          <div>
            <dt>Краткое содержание</dt>
            <dd className="break">{doc.contentSummary || "—"}</dd>
          </div>
          <div>
            <dt>Ошибка</dt>
            <dd className={`break ${doc.error ? "error-text" : ""}`}>
              {doc.error || "—"}
            </dd>
          </div>
        </dl>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </Overlay>
  );
}
