import { useI18n } from "../I18nProvider.tsx";
import { formatNumber } from "../i18n.ts";
import { meterFraction, meterZone, toDbfs } from "../micLevel.ts";
import { useMicLevel } from "../useMicLevel.ts";

const ZONE_TEXT = {
  silent: "ui.mic.silentZone",
  low: "ui.mic.lowZone",
  ok: "ui.mic.okZone",
} as const;

interface Props {
  track: MediaStreamTrack | null;
}

/** 麦克风电平条：浏览器采集后、服务端增益之前的电平，一眼看出麦克风有没有收到声音、有多轻。 */
export function MicMeter({ track }: Props) {
  const { locale, t } = useI18n();
  const rms = useMicLevel(track);
  if (!track) return null;
  const zone = meterZone(rms);
  const db = toDbfs(rms);
  const label = Number.isFinite(db)
    ? `${formatNumber(locale, Number(db.toFixed(0)))} dBFS`
    : t("ui.mic.silent");
  return (
    <div
      className={`mic-meter mic-meter-${zone}`}
      role="meter"
      aria-label={t("ui.mic.label")}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(meterFraction(rms).toFixed(2))}
      title={t("ui.mic.title", { level: label, zone: t(ZONE_TEXT[zone]) })}
    >
      <span className="mic-meter-icon" aria-hidden="true">
        🎙
      </span>
      <span className="mic-meter-track">
        <span className="mic-meter-fill" style={{ width: `${meterFraction(rms) * 100}%` }} />
      </span>
    </div>
  );
}
