import { useI18n } from "../I18nProvider.tsx";
import { useEffect, useState } from "react";

import { formatFrameTime, frameImageUrl } from "../screenCapture.ts";
import {
  TASK_STATUS_LABELS,
  artifactUrl,
  isFinished,
  isImageArtifact,
  safeLink,
  taskDuration,
  taskBrief,
  taskFailure,
  taskDiagnostic,
  eventDiagnostic,
  taskSubline,
  type TaskDetail,
  type TaskItem,
} from "../tasks.ts";

interface Props {
  tasks: readonly TaskItem[];
  onLoad: (id: string) => Promise<TaskDetail | null>;
  onCancel: (id: string) => void;
}

/** 后台任务面板：列表（状态、最近一步或结论），点开看详细结果、来源、产物、进度，以及这次任务外发了什么。 */
export function TaskPanel({ tasks, onLoad, onCancel }: Props) {
  const { locale, t } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const open = openId === null ? null : (tasks.find((t) => t.id === openId) ?? null);

  // 打开时取一次；任务状态变了（比如做完了）再取一次，拿到结果
  const openStatus = open?.status;
  useEffect(() => {
    if (openId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void onLoad(openId).then((loaded) => {
      if (!cancelled) setDetail(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [openId, openStatus, onLoad]);

  useEffect(() => {
    if (openId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  if (tasks.length === 0) return null; // 没有交办过任务时不占地方

  return (
    <section className="panel tasks-panel" aria-label={t("ui.task.label")}>
      <h2>{t("ui.task.label")}</h2>
      <ul className="tasks">
        {[...tasks].reverse().map((task) => (
          <li key={task.id}>
            <button type="button" className="task" onClick={() => setOpenId(task.id)}>
              <span className="task-head">
                <span className="task-label">{task.label}</span>
                <span className={`badge badge-task-${task.status}`}>
                  {t(TASK_STATUS_LABELS[task.status])}
                </span>
                {task.modality === "text" && <span className="tag">{t("ui.textTag")}</span>}
              </span>
              <span className="task-goal">{task.goal}</span>
              <span className="task-sub">{taskSubline(task, locale)}</span>
              {task.status === "running" && task.last_event && eventDiagnostic(task.last_event) && (
                <span className="task-sub">
                  {t("ui.diagnostic", { text: eventDiagnostic(task.last_event)! })}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("ui.task.dialog", { label: open.label })}
          onClick={() => setOpenId(null)}
        >
          <article className="task-detail" onClick={(event) => event.stopPropagation()}>
            <header>
              <h3>
                {open.label}{" "}
                <span className={`badge badge-task-${open.status}`}>
                  {t(TASK_STATUS_LABELS[open.status])}
                </span>
              </h3>
              <span className="spacer" />
              {!isFinished(open.status) && (
                <button
                  type="button"
                  className="link link-danger"
                  onClick={() => onCancel(open.id)}
                >
                  {t("ui.task.cancel")}
                </button>
              )}
              <button type="button" className="link" onClick={() => setOpenId(null)}>
                {t("ui.close")}
              </button>
            </header>
            <p className="task-detail-goal">{open.goal}</p>
            {open.status === "succeeded" && (open.brief || open.brief_message) && (
              <p className="task-detail-brief">{taskBrief(open, locale)}</p>
            )}
            {(open.status === "failed" || open.status === "cancelled") && (
              <div>
                <p className="notice notice-error">{taskFailure(open, locale)}</p>
                {taskDiagnostic(open) && (
                  <p>{t("ui.diagnostic", { text: taskDiagnostic(open)! })}</p>
                )}
              </div>
            )}
            {detail === null || detail.id !== open.id ? (
              <p className="empty">{t("ui.task.loading")}</p>
            ) : (
              <TaskBody detail={detail} />
            )}
          </article>
        </div>
      )}
    </section>
  );
}

function TaskBody({ detail }: { detail: TaskDetail }) {
  const { locale, t } = useI18n();
  const duration = taskDuration(detail.started_at, detail.finished_at, locale);
  const images = detail.artifacts.filter(isImageArtifact);
  const files = detail.artifacts.filter((name) => !isImageArtifact(name));
  return (
    <>
      {detail.detail_md && (
        <>
          <h4>{t("ui.task.detail")}</h4>
          {/* 远端模型写的内容按纯文字显示，不当 HTML 解释 */}
          <pre className="task-markdown">{detail.detail_md}</pre>
        </>
      )}
      {images.length > 0 && (
        <div className="task-images">
          {images.map((name) => (
            <a key={name} href={artifactUrl(detail.id, name)} target="_blank" rel="noreferrer">
              <img src={artifactUrl(detail.id, name)} alt={name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <>
          <h4>{t("ui.task.artifacts")}</h4>
          <ul className="task-list">
            {files.map((name) => (
              <li key={name}>
                <a className="link" href={artifactUrl(detail.id, name)} download>
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail.sources.length > 0 && (
        <>
          <h4>{t("ui.task.sources")}</h4>
          <ul className="task-list">
            {detail.sources.map((source) => {
              const href = safeLink(source);
              return (
                <li key={source}>
                  {href ? (
                    <a className="link" href={href} target="_blank" rel="noreferrer">
                      {source}
                    </a>
                  ) : (
                    source
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <h4>{duration ? t("ui.task.progressDuration", { duration }) : t("ui.task.progress")}</h4>
      <ol className="task-events">
        {detail.events.map((event, index) => (
          <li key={index} className={`task-event task-event-${event.kind}`}>
            {t(event.message?.code ?? "task.event.unknown", event.message?.params)}
            {event.error_message && (
              <p>{t(event.error_message.code, event.error_message.params)}</p>
            )}
            {event.brief_message && (
              <p>{t(event.brief_message.code, event.brief_message.params)}</p>
            )}
            {eventDiagnostic(event) && (
              <p>{t("ui.diagnostic", { text: eventDiagnostic(event)! })}</p>
            )}
          </li>
        ))}
      </ol>
      <h4>{t("ui.task.outbound")}</h4>
      <p className="task-outbound">
        {detail.outbound.model_host
          ? t("ui.task.outboundHost", { host: detail.outbound.model_host })
          : t("ui.task.outboundModel")}
        {t("ui.task.outboundTranscript", {
          from: formatFrameTime(detail.outbound.t_from, locale),
          to: formatFrameTime(detail.outbound.t_to, locale),
        })}
        {detail.outbound.frames.length > 0
          ? t("ui.task.outboundFrames", { count: detail.outbound.frames.length })
          : t("ui.task.outboundNoFrames")}
        {t("ui.task.requester", { name: detail.requested_by })}
      </p>
      {detail.outbound.frames.length > 0 && (
        <div className="task-images task-images-small">
          {detail.outbound.frames.map((frame) => (
            <a key={frame.id} href={frameImageUrl(frame.id)} target="_blank" rel="noreferrer">
              <img
                src={frameImageUrl(frame.id)}
                alt={t("ui.screen.at", { time: formatFrameTime(frame.t, locale) })}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
    </>
  );
}
