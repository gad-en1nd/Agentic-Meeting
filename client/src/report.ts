import { translate, type Locale, type MessageRef } from "./i18n.ts";
// 会后报告的显示逻辑（docs/interfaces.md §5.6）。不碰 DOM。

import type { SessionState } from "./api.ts";

export type ReportStatus = "running" | "done" | "failed";

/** `GET /api/sessions/{id}/report` 返回的最近一份报告。 */
export interface ReportInfo {
  id: number;
  status: ReportStatus;
  created_at: number;
  provider: string;
  text_md: string;
  error: string | null;
  error_message?: MessageRef | null;
}

/** 生成期间多久问一次服务端。 */
export const REPORT_POLL_MS = 2000;

export const REPORT_PROVIDER_LABELS: Record<string, string> = {
  realtime_llm: "ui.report.realtimeProvider",
  agent_llm: "ui.report.agentProvider",
};

/** 报告的下载地址。 */
export function reportDownloadUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/report.md`;
}

/**
 * 现在为什么不能生成报告；可以生成时返回 null。
 * 会议要先结束或断开（服务端也会拒绝进行中的会议）；已经有一份在生成时不能再点。
 */
export function reportBlocker(
  session: { state: SessionState; utterance_count: number } | null,
  report: Pick<ReportInfo, "status"> | null,
  locale: Locale,
): string | null {
  if (!session) return translate(locale, "ui.report.noSession");
  if (session.state === "live") return translate(locale, "ui.report.live");
  if (report?.status === "running") return translate(locale, "ui.report.busy");
  if (session.utterance_count === 0) return translate(locale, "ui.report.noUtterances");
  return null;
}

/** 按钮上的字：没有报告时「生成报告」，有了之后「重新生成」。 */
export function generateLabel(report: Pick<ReportInfo, "status"> | null, locale: Locale): string {
  return translate(locale, report === null ? "ui.report.generate" : "ui.report.regenerate");
}

/** 报告区顶上那行说明。 */
export function reportHeadline(report: ReportInfo | null, locale: Locale): string {
  if (report === null) return translate(locale, "ui.report.none");
  const provider = REPORT_PROVIDER_LABELS[report.provider];
  const who = provider ? translate(locale, provider) : report.provider;
  switch (report.status) {
    case "running":
      return translate(locale, "ui.report.running", { provider: who });
    case "failed": {
      const reason = report.error_message
        ? translate(locale, report.error_message.code, report.error_message.params)
        : translate(locale, "report.failure.unknown");
      return translate(locale, "ui.report.failed", { reason });
    }
    case "done":
      return translate(locale, "ui.report.done", { provider: who });
  }
}

export function reportDiagnostic(report: ReportInfo): string | null {
  return !report.error_message || report.error_message.code === "report.failure.unknown"
    ? report.error
    : null;
}
