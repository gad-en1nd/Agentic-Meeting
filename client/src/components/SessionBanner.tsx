import { useI18n } from "../I18nProvider.tsx";
import { useEffect, useState } from "react";

import type { SessionSummary } from "../api.ts";
import type { ConnectionState } from "../meetingState.ts";
import { formatSpan, interruptedSecs } from "../resume.ts";
import {
  STATE_LABELS,
  canResume,
  exportUrl,
  formatDuration,
  formatStartedAt,
  sessionTitle,
} from "../sessionView.ts";

interface Props {
  session: SessionSummary | null;
  connection: ConnectionState;
  /** 连接意外断开后正在自动重连：第几次；0 表示没有 */
  reconnectAttempt: number;
  /** 正在只读地看一场在别的设备上进行的会议 */
  watching: boolean;
  keepPending: boolean;
  onKeep: (id: string, keep: boolean) => void;
  onRename: (id: string, title: string) => void;
  onResume: (id: string) => void;
  onStart: () => void;
}

/** 字幕区上方的一行：正在看的是哪一场会议、什么状态、开始于何时；标题可以点开改；没在开的会议可以继续。 */
export function SessionBanner({
  session,
  connection,
  reconnectAttempt,
  watching,
  onRename,
  onKeep,
  keepPending,
  onResume,
  onStart,
}: Props) {
  const { locale, t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  // 「已中断 12 分钟」要跟着时间走：半分钟刷新一次
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!session) {
    return <p className="banner banner-empty">{t("ui.session.empty")}</p>;
  }

  const commit = () => {
    if (editing !== null && editing.trim() !== session.title.trim()) onRename(session.id, editing);
    setEditing(null);
  };
  const idle = !session.deletion_pending && canResume(connection) && reconnectAttempt === 0;
  const interrupted = session.state === "interrupted" && idle;

  return (
    <div className="banner" role="group" aria-label={t("ui.session.current")}>
      {editing === null ? (
        <>
          <strong className="banner-title">{sessionTitle(session, locale)}</strong>
          <button
            type="button"
            className="link"
            disabled={session.deletion_pending}
            aria-label={t("ui.session.renameCurrent")}
            onClick={() => setEditing(session.title)}
          >
            ✎
          </button>
        </>
      ) : (
        <input
          className="banner-input"
          aria-label={t("ui.session.title")}
          value={editing}
          maxLength={200}
          autoFocus
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(null);
          }}
        />
      )}
      <span className={`badge badge-session-${session.state}`}>
        {t(session.deletion_pending ? "ui.session.pending" : STATE_LABELS[session.state])}
      </span>
      <span className="banner-meta">
        {t("ui.session.meta", {
          date: formatStartedAt(session.started_at, locale),
          duration: formatDuration(session.duration_secs, locale),
          count: session.utterance_count,
        })}
      </span>
      <button
        type="button"
        className="link"
        aria-pressed={session.keep}
        disabled={session.deletion_pending || keepPending}
        title={t("ui.session.keepHelp")}
        onClick={() => onKeep(session.id, !session.keep)}
      >
        {t(
          keepPending ? "ui.session.saving" : session.keep ? "ui.session.kept" : "ui.session.keep",
        )}
      </button>
      {session.deletion_pending && (
        <span className="banner-hint banner-hint-warn">{t("ui.session.deleteWarning")}</span>
      )}
      {!session.deletion_pending && (
        <span className="banner-exports">
          {t("ui.session.exports")}
          <a className="link" href={exportUrl(session.id)} download>
            {t("ui.session.transcript")}
          </a>
          <a className="link" href={exportUrl(session.id, "json")} download>
            JSON
          </a>
          <a
            className="link"
            href={exportUrl(session.id, "zip")}
            download
            title={t("ui.session.packageHelp")}
          >
            {t("ui.session.package")}
          </a>
        </span>
      )}
      {reconnectAttempt > 0 && (
        <span className="banner-hint banner-hint-warn">
          {t("ui.session.reconnecting", { attempt: reconnectAttempt })}
        </span>
      )}
      {watching && !session.deletion_pending && (
        <span className="banner-hint">
          {t("ui.session.watching")}
          <button type="button" className="link" onClick={() => onResume(session.id)}>
            {t("ui.session.takeover")}
          </button>
        </span>
      )}
      {interrupted && (
        <span className="banner-hint">
          {interruptedSecs(session, now) < 60
            ? t("ui.session.justInterrupted")
            : t("ui.session.interruptedFor", {
                duration: formatSpan(interruptedSecs(session, now), locale),
              })}
          <button
            type="button"
            className="button button-start button-small"
            onClick={() => onResume(session.id)}
          >
            {t("ui.session.resume")}
          </button>
          <button type="button" className="link" onClick={onStart}>
            {t("ui.session.start")}
          </button>
        </span>
      )}
      {session.state === "ended" && idle && (
        <button type="button" className="link" onClick={() => onResume(session.id)}>
          {t("ui.session.resumeCurrent")}
        </button>
      )}
    </div>
  );
}
