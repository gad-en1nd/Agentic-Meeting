import { useI18n } from "../I18nProvider.tsx";
import type { LocalePreference } from "../i18n.ts";

/** 登录与会议页共用；切换只影响当前页面的显示语言。 */
export function LanguageSelector() {
  const { preference, setPreference, t } = useI18n();
  return (
    <label className="language-selector">
      <span>{t("ui.language.label")}</span>
      <select
        aria-label={t("ui.language.label")}
        value={preference}
        onChange={(event) => setPreference(event.target.value as LocalePreference)}
      >
        <option value="auto">{t("ui.language.auto")}</option>
        <option value="zh-CN">{t("ui.language.chinese")}</option>
        <option value="en">{t("ui.language.english")}</option>
      </select>
    </label>
  );
}
