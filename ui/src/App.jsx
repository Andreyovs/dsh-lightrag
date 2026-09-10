import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import Header from "./components/Header";
import UploadPanel from "./components/UploadPanel";
import TrackPanel from "./components/TrackPanel";
import DocumentsTable from "./components/DocumentsTable";
import { DeleteModal, ReprocessModal, DocumentCardModal } from "./components/Modals";
import Toasts from "./components/Toasts";

const AUTO_REFRESH_MS = 5000;
const TRACK_POLL_MS = 3000;

export default function App() {
  const [status, setStatus] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [cardDoc, setCardDoc] = useState(null);
  const toastSeq = useRef(0);

  // --- Тосты -------------------------------------------------------------
  const addToast = useCallback((type, message) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, type, message }]);
    const ttl = type === "error" ? 6000 : 4000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --- Загрузка данных ----------------------------------------------------
  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [s, d] = await Promise.all([api.getStatus(), api.getDocuments()]);
        setStatus(s);
        setDocuments(Array.isArray(d?.documents) ? d.documents : []);
      } catch (e) {
        if (!silent) addToast("error", e.message);
      } finally {
        setLoading(false);
        if (!silent) setRefreshing(false);
      }
    },
    [addToast]
  );

  // Первый запрос
  useEffect(() => {
    refresh(true);
  }, [refresh]);

  const autoBusy =
    Boolean(status?.pipelineBusy) || tracks.some((t) => !t.done);

  // Автообновление: /status + /documents каждые 5 с,
  // пока pipelineBusy или есть незавершённые trackId.
  useEffect(() => {
    if (!autoBusy) return undefined;
    const id = setInterval(() => refresh(true), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoBusy, refresh]);

  // Опрос треков: GET /track/{id} раз в 3 с, пока done=false.
  useEffect(() => {
    const pending = tracks.filter((t) => !t.done);
    if (pending.length === 0) return undefined;
    const id = setInterval(() => {
      for (const t of pending) {
        api
          .getTrack(t.trackId)
          .then((data) => {
            setTracks((prev) =>
              prev.map((x) =>
                x.trackId === data.trackId ? { ...x, ...data } : x
              )
            );
          })
          .catch(() => {
            /* трек ещё не синхронизирован — опрос продолжится */
          });
      }
    }, TRACK_POLL_MS);
    return () => clearInterval(id);
  }, [tracks]);

  // --- Загрузка файлов / текста -------------------------------------------
  const addTrack = useCallback((data, source) => {
    const trackId = data?.trackId;
    if (!trackId) return;
    setTracks((prev) => {
      if (prev.some((t) => t.trackId === trackId)) return prev;
      const entry = {
        trackId,
        done: false,
        documents: [],
        statusSummary: {},
        totalCount: 0,
        source,
        addedAt: Date.now(),
      };
      return [entry, ...prev].slice(0, 12);
    });
  }, []);

  const handleUpload = useCallback(
    async (files) => {
      try {
        const res = await api.uploadFiles(files);
        addToast("success", res?.message || "Файлы отправлены на обработку");
        addTrack(res, "files");
        refresh(true);
      } catch (e) {
        addToast("error", e.message);
      }
    },
    [addToast, addTrack, refresh]
  );

  const handleText = useCallback(
    async (text, fileSource) => {
      try {
        const res = await api.addText(text, fileSource);
        addToast("success", res?.message || "Текст добавлен в базу");
        addTrack(res, "text");
        refresh(true);
      } catch (e) {
        addToast("error", e.message);
      }
    },
    [addToast, addTrack, refresh]
  );

  // --- Действия с документами ----------------------------------------------
  const handleDelete = useCallback(
    async (documentId, deleteFile) => {
      try {
        const res = await api.deleteDocument(documentId, deleteFile);
        addToast("success", res?.message || "Документ удалён");
        setDocuments((prev) => prev.filter((d) => d.id !== documentId));
        refresh(true);
      } catch (e) {
        addToast("error", e.message);
      } finally {
        setDeleteTarget(null);
      }
    },
    [addToast, refresh]
  );

  const handleReprocess = useCallback(async () => {
    try {
      const res = await api.reprocessAll();
      addToast("success", res?.message || "Повторная обработка запущена");
      refresh(true);
    } catch (e) {
      addToast("error", e.message);
    } finally {
      setReprocessOpen(false);
    }
  }, [addToast, refresh]);

  return (
    <div className="app">
      <Header status={status} />

      <main className="layout">
        <section className="col main-col">
          <DocumentsTable
            documents={documents}
            loading={loading}
            refreshing={refreshing}
            onCard={setCardDoc}
            onRetry={() => setReprocessOpen(true)}
            onDelete={setDeleteTarget}
            onRefresh={() => refresh()}
          />
        </section>

        <aside className="col side-col">
          <UploadPanel
            onFiles={handleUpload}
            onText={handleText}
            notifyError={(m) => addToast("error", m)}
          />
          <TrackPanel tracks={tracks} />
        </aside>
      </main>

      {deleteTarget && (
        <DeleteModal
          doc={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(deleteFile) =>
            handleDelete(deleteTarget.id, deleteFile)
          }
        />
      )}
      {reprocessOpen && (
        <ReprocessModal
          onCancel={() => setReprocessOpen(false)}
          onConfirm={handleReprocess}
        />
      )}
      {cardDoc && (
        <DocumentCardModal doc={cardDoc} onClose={() => setCardDoc(null)} />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
