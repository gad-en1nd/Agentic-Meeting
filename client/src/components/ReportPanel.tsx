import { useI18n } from "../I18nProvider.tsx";
import type { SessionSummary } from "../api.ts";
import {
  generateLabel,
  reportBlocker,
  reportDownloadUrl,
  reportHeadline,
  reportDiagnostic,
  type ReportInfo,
} from "../report.ts";

interface Props {
  session: SessionSummary | null;
  report: ReportInfo | null;
  onGenerate: () => void;
}

/** 会后报告：生成、查看（保留换行的文本）、下载。生成期间页面每 2 秒问一次服务端。 */
export function ReportPanel({ session, report, onGenerate }: Props) {
  const { locale, t } = useI18n();
  const blocker = reportBlocker(session, report, locale);
  return (
    <section className="panel report-panel" aria-label={t("ui.report.label")}>
      <div className="report-head">
        <p className={report?.status === "failed" ? "notice notice-error" : "report-status"}>
          {reportHeadline(report, locale)}
        </p>
        <span className="spacer" />
        {session && report?.status === "done" && (
          <a className="link" href={reportDownloadUrl(session.id)} download>
            {t("ui.report.download")}
          </a>
        )}
        <button
          type="button"
          className="button button-start button-small"
          disabled={blocker !== null}
          title={blocker ?? undefined}
          onClick={onGenerate}
        >
          {generateLabel(report, locale)}
        </button>
      </div>
      {blocker !== null && report?.status !== "running" && <p className="report-hint">{blocker}</p>}
      {report?.status === "failed" && reportDiagnostic(report) && (
        <p className="report-hint">{t("ui.diagnostic", { text: reportDiagnostic(report)! })}</p>
      )}
      {report?.status === "done" && (
        // 模型写的内容按纯文字显示，不当 HTML 解释
        <pre className="report-text">{report.text_md}</pre>
      )}
    </section>
  );
}
