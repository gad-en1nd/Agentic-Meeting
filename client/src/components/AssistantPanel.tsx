import { useI18n } from "../I18nProvider.tsx";
import type { Notice, ReplyMode } from "../meetingState.ts";
import type { AssistantStateName } from "../protocol.ts";
import { TextInput } from "./TextInput.tsx";

const STATE_LABELS: Record<AssistantStateName, string> = {
  idle: "ui.assistant.idle",
  listening: "ui.assistant.listening",
  thinking: "ui.assistant.thinking",
  speaking: "ui.assistant.speaking",
};

const REPLY_LABELS: Record<ReplyMode, string> = {
  text: "ui.reply.text",
  voice: "ui.reply.voice",
};

interface Props {
  state: AssistantStateName;
  text: string;
  replyMode: ReplyMode | null;
  notices: readonly Notice[];
  /** 已连接：可以用文字输入框向助理提问 */
  canSend: boolean;
  onSend: (text: string) => boolean;
  onDismissNotice: (id: number) => void;
}

/** 助理区：状态、这一轮应答的流式文字（以及是文字回答还是语音回答）、需要让用户知道的提示、文字输入框。 */
export function AssistantPanel({
  state,
  text,
  replyMode,
  notices,
  canSend,
  onSend,
  onDismissNotice,
}: Props) {
  const { t } = useI18n();
  return (
    <section className="panel assistant-panel" aria-label={t("ui.assistant.label")}>
      <h2>
        {t("ui.assistant.label")}{" "}
        <span className={`badge badge-${state}`}>{t(STATE_LABELS[state])}</span>
        {text && replyMode && <span className="reply-mode">{t(REPLY_LABELS[replyMode])}</span>}
      </h2>
      <ul className="notices">
        {notices.map((notice) => (
          <li key={notice.id} className={`notice notice-${notice.level}`}>
            <span>
              {notice.cause
                ? t("ui.error.operation", {
                    operation: t(notice.message.code, notice.message.params),
                    reason: t(notice.cause.code, notice.cause.params),
                  })
                : t(notice.message.code, notice.message.params)}
            </span>
            <button
              type="button"
              aria-label={t("ui.notice.dismiss")}
              onClick={() => onDismissNotice(notice.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="reply">
        {text ? <p>{text}</p> : <p className="empty">{t("ui.assistant.empty")}</p>}
      </div>
      <TextInput enabled={canSend} onSend={onSend} />
    </section>
  );
}
