import { useI18n } from "../I18nProvider.tsx";
import { useState } from "react";

import type { SessionSummary } from "../api.ts";
import {
  STATE_LABELS,
  canDelete,
  formatDuration,
  formatStartedAt,
  previewLine,
  sessionTitle,
} from "../sessionView.ts";

interface Props {
  sessions: readonly SessionSummary[];
  viewingId: string | null;
  /** 连接期间不能切到别的会议去看 */
  locked: boolean;
  onSelect: (id: string) => void;
  onResume: (id: string) => void;
  onRename: (id: string, title: string) => void;
  keepPending: ReadonlySet<string>;
  onKeep: (id: string, keep: boolean) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/** 会议列表（抽屉）：最近的会议，点一场在字幕区查看；可以继续、重命名、删除。 */
export function SessionList({
  sessions,
  viewingId,
  locked,
  onSelect,
  onResume,
  onRename,
  onDelete,
  onKeep,
  keepPending,
  onClose,
}: Props) {
  const { locale, t } = useI18n();
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);

  const commit = () => {
    if (editing) onRename(editing.id, editing.title);
    setEditing(null);
  };

  return (
    <aside className="drawer" id="session-list" aria-label={t("ui.session.list")}>
      <div className="drawer-head">
        <h2>{t("ui.session.recent")}</h2>
        <button
          type="button"
          className="link"
          aria-label={t("ui.session.closeList")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {locked && <p className="drawer-hint">{t("ui.session.locked")}</p>}
      {sessions.length === 0 ? (
        <p className="empty">{t("ui.session.noRecords")}</p>
      ) : (
        <ul className="sessions">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`session session-${s.state}${s.id === viewingId ? " session-current" : ""}`}
            >
              {editing?.id === s.id ? (
                <input
                  className="banner-input"
                  aria-label={t("ui.session.title")}
                  value={editing.title}
                  maxLength={200}
                  autoFocus
                  onChange={(event) => setEditing({ id: s.id, title: event.target.value })}
                  onBlur={commit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commit();
                    if (event.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="session-main"
                  disabled={locked && s.state !== "live"}
                  onClick={() => onSelect(s.id)}
                >
                  <span className="session-title">{sessionTitle(s, locale)}</span>
                  <span className={`badge badge-session-${s.state}`}>
                    {t(s.deletion_pending ? "ui.session.pending" : STATE_LABELS[s.state])}
                  </span>
                  <span className="session-meta">
                    {t("ui.session.listMeta", {
                      date: formatStartedAt(s.started_at, locale),
                      duration: formatDuration(s.duration_secs, locale),
                      count: s.utterance_count,
                    })}
                  </span>
                  {!s.deletion_pending && previewLine(s) && (
                    <span className="session-preview">{previewLine(s)}</span>
                  )}
                </button>
              )}
              <span className="session-actions">
                <button
                  type="button"
                  className="link"
                  aria-pressed={s.keep}
                  aria-label={t("ui.session.keepNamed", { title: sessionTitle(s, locale) })}
                  disabled={s.deletion_pending || keepPending.has(s.id)}
                  title={t("ui.session.keepHelp")}
                  onClick={() => onKeep(s.id, !s.keep)}
                >
                  {t(
                    keepPending.has(s.id)
                      ? "ui.session.saving"
                      : s.keep
                        ? "ui.session.kept"
                        : "ui.session.keep",
                  )}
                </button>
                {!locked && !s.deletion_pending && (
                  <button
                    type="button"
                    className="link"
                    aria-label={t("ui.session.resumeNamed", { title: sessionTitle(s, locale) })}
                    title={s.state === "live" ? t("ui.session.takeoverHelp") : undefined}
                    onClick={() => onResume(s.id)}
                  >
                    {t(s.state === "live" ? "ui.session.takeoverShort" : "ui.session.resume")}
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={s.deletion_pending}
                  aria-label={t("ui.session.renameNamed", { title: sessionTitle(s, locale) })}
                  onClick={() => setEditing({ id: s.id, title: s.title })}
                >
                  {t("ui.session.rename")}
                </button>
                <button
                  type="button"
                  className="link link-danger"
                  aria-label={t("ui.session.deleteNamed", { title: sessionTitle(s, locale) })}
                  disabled={!canDelete(s)}
                  title={canDelete(s) ? undefined : t("ui.session.deleteBlocked")}
                  onClick={() => {
                    if (
                      window.confirm(
                        t("ui.session.deleteConfirm", { title: sessionTitle(s, locale) }),
                      )
                    ) {
                      onDelete(s.id);
                    }
                  }}
                >
                  {t(s.deletion_pending ? "ui.session.deleteRetry" : "ui.session.delete")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
