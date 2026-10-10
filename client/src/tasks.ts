import { parseMessage, translate, formatNumber, type Locale, type MessageRef } from "./i18n.ts";
// 后台任务面板的纯逻辑（docs/interfaces.md §5.5、§6.1）。不碰 DOM。

export const TASK_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "ui.task.queued",
  running: "ui.task.running",
  succeeded: "ui.task.succeeded",
  failed: "ui.task.failed",
  cancelled: "ui.task.cancelled",
};

/** 任务面板里的一行。`id` 是完整编号，`label` 是会议内的短编号（t3）。 */
export interface TaskItem {
  id: string;
  label: string;
  goal: string;
  status: TaskStatus;
  brief: string | null;
  error: string | null;
  /** 委托当时的应答模态：文字委托的任务完成后不出声 */
  modality: "voice" | "text";
  created_at: number;
  error_message?: MessageRef | null;
  brief_message?: MessageRef | null;
  last_event?: TaskEventItem | null;
}

export interface TaskEventItem {
  id?: number;
  message?: MessageRef | null;
  error_message?: MessageRef | null;
  brief_message?: MessageRef | null;
  diagnostic?: string | null;
  at: number;
  kind: string;
  summary: string;
}

/** 任务详情（GET /api/tasks/{id}）。 */
export interface TaskDetail extends TaskItem {
  started_at: number | null;
  finished_at: number | null;
  detail_md: string;
  sources: string[];
  artifacts: string[];
  requested_by: string;
  requested_t: number;
  events: TaskEventItem[];
  /** 这次任务外发给远端模型的内容 */
  outbound: {
    goal: string;
    t_from: number;
    t_to: number;
    frames: { id: number; t: number }[];
    model_host: string;
  };
}

export function isFinished(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** 缺少来源的历史内容保留原文；坏的结构化来源只作为通用系统说明。 */
export function optionalMessage(value: unknown, fallback: string): MessageRef | null {
  return value === null || value === undefined ? null : parseMessage(value, fallback);
}

export function parseTaskEvent(value: unknown): TaskEventItem | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.at !== "number" ||
    !Number.isFinite(event.at) ||
    typeof event.kind !== "string" ||
    typeof event.summary !== "string"
  )
    return null;
  return {
    id: typeof event.id === "number" && Number.isInteger(event.id) ? event.id : undefined,
    at: event.at,
    kind: event.kind,
    summary: event.summary,
    message: optionalMessage(event.message, "task.event.unknown"),
    error_message: optionalMessage(event.error_message, "task.failure.unknown"),
    brief_message: optionalMessage(event.brief_message, "task.result.fallback"),
    diagnostic:
      typeof event.diagnostic === "string" && [...event.diagnostic].length <= 200
        ? event.diagnostic
        : null,
  };
}

export function parseTaskItem(task: TaskItem): TaskItem {
  return {
    ...task,
    error_message: optionalMessage(task.error_message, "task.failure.unknown"),
    brief_message: optionalMessage(task.brief_message, "task.result.fallback"),
    last_event: task.last_event === undefined ? undefined : parseTaskEvent(task.last_event),
  };
}

export function parseTaskDetail(detail: TaskDetail): TaskDetail {
  return {
    ...detail,
    ...parseTaskItem(detail),
    events: detail.events
      .map(parseTaskEvent)
      .filter((event): event is TaskEventItem => event !== null),
  };
}

function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

export function applyTask(tasks: readonly TaskItem[], raw: TaskItem): TaskItem[] {
  const task = parseTaskItem(raw);
  const existing = tasks.find((t) => t.id === task.id);
  const merged = {
    ...task,
    last_event: task.last_event === undefined ? existing?.last_event : task.last_event,
  };
  return sortTasks([...tasks.filter((t) => t.id !== task.id), merged]);
}

export function applyTaskEvent(
  tasks: readonly TaskItem[],
  taskId: string,
  event: TaskEventItem,
): TaskItem[] {
  return tasks.map((task) => (task.id === taskId ? { ...task, last_event: event } : task));
}

export function replaceTasks(tasks: readonly TaskItem[], items: readonly TaskItem[]): TaskItem[] {
  const previous = new Map(tasks.map((t) => [t.id, t.last_event]));
  return sortTasks(
    items.map((raw) => {
      const task = parseTaskItem(raw);
      return {
        ...task,
        last_event: task.last_event === undefined ? previous.get(task.id) : task.last_event,
      };
    }),
  );
}

export function taskBrief(task: TaskItem, locale: Locale): string {
  return task.brief_message
    ? translate(locale, task.brief_message.code, task.brief_message.params)
    : task.brief || translate(locale, "ui.task.succeeded");
}

export function taskFailure(task: TaskItem, locale: Locale): string {
  const message = task.error_message;
  return message
    ? translate(locale, message.code, message.params)
    : translate(
        locale,
        task.status === "cancelled" ? "task.failure.cancelled" : "task.failure.unknown",
      );
}

export function taskDiagnostic(task: TaskItem): string | null {
  return !task.error_message ||
    ["task.failure.unknown", "task.failure.runtime"].includes(task.error_message.code)
    ? task.error
    : null;
}

export function eventDiagnostic(event: TaskEventItem): string | null {
  return (
    event.diagnostic ||
    (!event.message || event.message.code === "task.event.unknown" ? event.summary : null)
  );
}

export function taskSubline(task: TaskItem, locale: Locale): string {
  if (task.status === "succeeded") return taskBrief(task, locale);
  if (task.status === "failed" || task.status === "cancelled") return taskFailure(task, locale);
  if (task.status === "queued") return translate(locale, "ui.task.queueHint");
  const message = task.last_event?.message;
  return message
    ? translate(locale, message.code, message.params)
    : translate(locale, "ui.task.startHint");
}

/** 产物文件的地址。任务编号和文件名都要编码（文件名可以带子目录）。 */
export function artifactUrl(taskId: string, name: string): string {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${path}`;
}

/** 能直接当图片显示的产物。 */
export function isImageArtifact(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

/** 来源链接只认 http(s)：远端模型给的内容不可信，别的协议（javascript: 之类）不做成链接。 */
export function safeLink(source: string): string | null {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** 用时：不到一分钟写秒，否则「N 分 SS 秒」。还没结束返回空串。 */
export function taskDuration(
  startedAt: number | null,
  finishedAt: number | null,
  locale: Locale,
): string {
  if (startedAt === null || finishedAt === null) return "";
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt))
    return translate(locale, "format.unavailable");
  const secs = Math.max(0, Math.round(finishedAt - startedAt));
  if (secs < 60) return translate(locale, "ui.duration.seconds", { seconds: secs });
  return translate(locale, "ui.duration.minSec", {
    minutes: Math.floor(secs / 60),
    seconds: formatNumber(locale, secs % 60).padStart(2, "0"),
  });
}
