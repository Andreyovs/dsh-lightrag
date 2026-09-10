import { useRef, useState } from "react";

/**
 * Блок загрузки: вкладки «Файлы» (drag&drop + выбор с диска)
 * и «Текст» (textarea + необязательное имя документа).
 */
export default function UploadPanel({ onFiles, onText, notifyError }) {
  const [tab, setTab] = useState("files");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileSource, setFileSource] = useState("");
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  const submitFiles = async (fileList) => {
    const files = Array.from(fileList ?? []).filter(Boolean);
    if (busy) return;
    if (files.length === 0) {
      notifyError("Не выбраны файлы");
      return;
    }
    setBusy(true);
    try {
      await onFiles(files);
    } finally {
      setBusy(false);
    }
  };

  const submitText = async () => {
    if (busy) return;
    if (!text.trim()) {
      notifyError("Введите текст, который нужно добавить");
      return;
    }
    setBusy(true);
    try {
      await onText(text, fileSource.trim());
      setText("");
      setFileSource("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">Загрузка</h2>
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "files"}
          className={tab === "files" ? "tab active" : "tab"}
          onClick={() => setTab("files")}
        >
          Файлы
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "text"}
          className={tab === "text" ? "tab active" : "tab"}
          onClick={() => setTab("text")}
        >
          Текст
        </button>
      </div>

      {tab === "files" ? (
        <div className="stack">
          <div
            className={dragOver ? "dropzone active" : "dropzone"}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              submitFiles(e.dataTransfer.files);
            }}
          >
            <p className="drop-main">Перетащите файлы сюда</p>
            <p className="muted">или выберите с диска — можно несколько</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              submitFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? "Загрузка…" : "Выбрать файлы…"}
          </button>
        </div>
      ) : (
        <div className="stack">
          <label className="field">
            <span className="muted">Имя документа (необязательно)</span>
            <input
              type="text"
              value={fileSource}
              placeholder="например, заметки.txt"
              disabled={busy}
              onChange={(e) => setFileSource(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="muted">Текст</span>
            <textarea
              rows={7}
              value={text}
              placeholder="Текст, который попадёт в базу знаний…"
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={submitText}
          >
            {busy ? "Добавление…" : "Добавить в базу"}
          </button>
        </div>
      )}
    </section>
  );
}
