import { useEffect, useMemo, useState } from "react";

type FeedbackStatus = "New" | "In Progress" | "Completed";

interface FeedbackComment {
  id: string;
  page: string;
  username: string;
  comment: string;
  status: FeedbackStatus;
  createdAt: string;
}

interface FeedbackPanelProps {
  enabled: boolean;
  visible: boolean;
  pageKey: string;
  pageLabel: string;
  onToggleVisible: () => void;
}

const API_BASE = "http://127.0.0.1:8000";

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-GB", { month: "short" });
  const year = date.getFullYear();

  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours %= 12;
  if (hours === 0) hours = 12;

  return `${day} ${month} ${year} ${hours}:${minutes} ${ampm}`;
}

function normalizeComment(raw: unknown): FeedbackComment | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const status: FeedbackStatus =
    item.status === "In Progress" || item.status === "Completed"
      ? item.status
      : "New";

  const username = String(item.username ?? "").trim();
  const comment = String(item.comment ?? "").trim();
  if (!username || !comment) return null;

  return {
    id: String(item.id ?? crypto.randomUUID()),
    page: String(item.page ?? "").trim(),
    username,
    comment,
    status,
    createdAt: String(item.createdAt ?? new Date().toISOString()),
  };
}

export function FeedbackPanel({ enabled, visible, pageKey, pageLabel, onToggleVisible }: FeedbackPanelProps) {
  const [username, setUsername] = useState("");
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<FeedbackComment[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [error, setError] = useState("");

  const loadComments = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/feedback?page=${encodeURIComponent(pageKey)}`);
      if (!response.ok) throw new Error("Failed to load feedback.");
      const payload = await response.json();
      const next = Array.isArray(payload?.data)
        ? payload.data
            .map((item: unknown) => normalizeComment(item))
            .filter((item: FeedbackComment | null): item is FeedbackComment => item !== null)
        : [];

      setComments(next);
      setError("");
    } catch {
      setError("Could not load feedback from server.");
    }
  };

  useEffect(() => {
    if (enabled) {
      loadComments();
    }
  }, [enabled, pageKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onToggleVisible();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggleVisible]);

  const canSubmit = username.trim().length > 0 && comment.trim().length > 0;

  const sortedComments = useMemo(
    () =>
      [...comments].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [comments],
  );

  const submitComment = async () => {
    if (!canSubmit) return;

    try {
      const response = await fetch(`${API_BASE}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: pageKey,
          username: username.trim(),
          comment: comment.trim(),
        }),
      });
      if (!response.ok) throw new Error("Failed to save comment.");

      const payload = await response.json();
      const next = normalizeComment(payload?.comment);
      if (next) {
        setComments((prev) => [next, ...prev]);
        setComment("");
        setError("");
      }
    } catch {
      setError("Could not save comment.");
    }
  };

  const deleteComment = async (id: string) => {
    try {
      const response = await fetch(`${API_BASE}/api/feedback/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete comment.");

      setComments((prev) => prev.filter((item) => item.id !== id));
      if (editingId === id) {
        setEditingId(null);
        setEditingText("");
      }
      setError("");
    } catch {
      setError("Could not delete comment.");
    }
  };

  const updateStatus = async (id: string, status: FeedbackStatus) => {
    try {
      const response = await fetch(`${API_BASE}/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error("Failed to update status.");

      setComments((prev) =>
        prev.map((item) => (item.id === id ? { ...item, status } : item)),
      );
      setError("");
    } catch {
      setError("Could not update status.");
    }
  };

  const startEdit = (item: FeedbackComment) => {
    setEditingId(item.id);
    setEditingText(item.comment);
  };

  const saveEdit = async () => {
    const nextValue = editingText.trim();
    if (!editingId || !nextValue) return;

    try {
      const response = await fetch(`${API_BASE}/api/feedback/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: nextValue }),
      });
      if (!response.ok) throw new Error("Failed to save edit.");

      setComments((prev) =>
        prev.map((item) =>
          item.id === editingId ? { ...item, comment: nextValue } : item,
        ),
      );
      setEditingId(null);
      setEditingText("");
      setError("");
    } catch {
      setError("Could not save edited comment.");
    }
  };

  return (
    <aside
      className={`feedback-panel ${visible ? "" : "is-collapsed"} ${enabled ? "" : "is-disabled"}`.trim()}
      aria-label="Testing feedback panel"
      aria-hidden={!enabled}
    >
      <div className="feedback-panel-header">
        <div>
          <h2>Feedback</h2>
          <p>{pageLabel}</p>
        </div>
        <button
          type="button"
          className="feedback-toggle-btn"
          onClick={onToggleVisible}
          title="Toggle panel (Ctrl+Shift+F)"
          aria-label="Toggle feedback panel"
        >
          {visible ? "Hide" : "Open"}
        </button>
      </div>

      {visible && (
        <>
          <div className="feedback-form">
            <label>
              Username
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Enter username"
              />
            </label>

            <label>
              Comment
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Describe issue, bug, or suggestion"
                rows={5}
                maxLength={2000}
              />
            </label>

            <button type="button" onClick={submitComment} disabled={!canSubmit}>
              Submit
            </button>
          </div>

          <div className="feedback-list-header">
            <strong>Comments</strong>
            <span>{sortedComments.length}</span>
          </div>

          {error && <p className="feedback-error">{error}</p>}

          <div className="feedback-list" role="list">
            {sortedComments.length === 0 && (
              <p className="feedback-empty">No comments yet.</p>
            )}

            {sortedComments.map((item) => (
              <article key={item.id} className="feedback-card" role="listitem">
                <header>
                  <strong>{item.username}</strong>
                  <time dateTime={item.createdAt}>{formatTimestamp(item.createdAt)}</time>
                </header>

                {editingId === item.id ? (
                  <div className="feedback-edit-wrap">
                    <textarea
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                      rows={4}
                      maxLength={2000}
                    />
                    <div className="feedback-card-actions">
                      <button type="button" onClick={saveEdit} disabled={!editingText.trim()}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingText("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>{item.comment}</p>
                )}

                <label className="feedback-status-row">
                  <span>Status</span>
                  <select
                    value={item.status}
                    onChange={(event) =>
                      updateStatus(item.id, event.target.value as FeedbackStatus)
                    }
                  >
                    <option value="New">New</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Completed">Completed</option>
                  </select>
                </label>

                <div className="feedback-card-actions">
                  {editingId !== item.id && (
                    <button type="button" className="ghost-button" onClick={() => startEdit(item)}>
                      Edit
                    </button>
                  )}
                  <button type="button" className="ghost-button" onClick={() => deleteComment(item.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
