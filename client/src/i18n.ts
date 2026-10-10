import { catalogs, networkMessageCodes, parameterTypes } from "./catalog";
import type { Locale, MessageParams } from "./catalog";

export type { Locale, MessageParams } from "./catalog";
export type LocalePreference = "auto" | Locale;
export type MessageRef = { code: string; params?: MessageParams };
export const LANGUAGE_STORAGE_KEY = "agentic-meeting.ui-language";
const networkCodes = new Set(networkMessageCodes);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "zh-CN";
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function validParams(code: string, value: unknown): value is MessageParams | undefined {
  if (!own(parameterTypes, code)) return false;
  const schema = parameterTypes[code];
  if (value === undefined) return Object.keys(schema).length === 0;
  if (!record(value) || Object.keys(value).length !== Object.keys(schema).length) return false;
  return Object.entries(schema).every(([name, type]) => {
    const parameter = value[name];
    if (!own(value, name) || typeof parameter !== type) return false;
    if (typeof parameter === "number" && !Number.isFinite(parameter)) return false;
    if (!networkCodes.has(code)) return true;
    if (typeof parameter === "string") {
      return parameter.trim().length > 0 && Array.from(parameter).length <= 61;
    }
    if (typeof parameter !== "number") return false;
    if (name === "maxSecs") return parameter > 0 && parameter <= 1_000_000;
    if (!Number.isInteger(parameter)) return false;
    if (name === "status") {
      return parameter >= (code === "task.failure.remote_status" ? 100 : 500) && parameter <= 599;
    }
    if (name === "chars") return parameter >= 0 && parameter <= 1_000_000_000;
    return parameter >= (name === "maxMB" ? 0 : 1) && parameter <= 1_000_000;
  });
}

function familiesFor(code: string): readonly string[] {
  if (code.startsWith("notice.")) return ["notice."];
  if (code.startsWith("task.failure.")) return ["task.failure."];
  if (code.startsWith("report.failure.")) return ["report.failure."];
  if (code === "task.result.fallback") return ["task.result.fallback"];
  if (code.startsWith("task.")) return ["task.event.", "task.tool.", "task.sandbox.", "task.mcp."];
  return ["error."];
}

export function parseMessage(
  value: unknown,
  fallbackCode: string,
  families: readonly string[] = familiesFor(fallbackCode),
): MessageRef {
  try {
    if (!record(value) || typeof value.code !== "string") return { code: fallbackCode };
    const code = value.code;
    if (
      networkCodes.has(code) &&
      families.some((family) =>
        family.endsWith(".") ? code.startsWith(family) : code === family,
      ) &&
      validParams(code, value.params)
    ) {
      return { code, params: value.params };
    }
  } catch {
    // 坏元数据不能中断字幕或其他界面状态更新。
  }
  return { code: fallbackCode };
}

function fallbackFor(code: string): string {
  if (code.startsWith("notice.")) return "notice.generic";
  if (code.startsWith("task.failure.")) return "task.failure.unknown";
  if (code.startsWith("report.failure.")) return "report.failure.unknown";
  if (code.startsWith("task.")) return "task.event.unknown";
  return "error.request.failed";
}

export function translate(locale: Locale, code: string, params?: MessageParams): string {
  const dictionary = catalogs[locale];
  if (!own(dictionary, code) || !validParams(code, params)) return dictionary[fallbackFor(code)];
  return dictionary[code].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = params![name];
    if (typeof value === "string") return value;
    // 原 maxSecs 使用 Python .0f；保留半偶数舍入和整秒显示。
    const rounded =
      name === "maxSecs"
        ? value - Math.floor(value) === 0.5
          ? Math.floor(value) + (Math.floor(value) % 2)
          : Math.round(value)
        : value;
    return formatNumber(locale, rounded);
  });
}

export function formatNumber(locale: Locale, value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(locale).format(value)
    : catalogs[locale]["format.unavailable"];
}

export function formatDateTime(locale: Locale, unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(unixSeconds) || !Number.isFinite(date.getTime()))
    return catalogs[locale]["format.unavailable"];
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

// 只用于会话卡片；任务和中断时长保留各自秒精度。
export function formatDuration(locale: Locale, seconds: number): string {
  if (!Number.isFinite(seconds)) return catalogs[locale]["format.unavailable"];
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes === 0) return translate(locale, "duration.less_than_minute");
  if (minutes < 60) return translate(locale, "duration.minutes", { minutes });
  return translate(locale, "duration.hours", {
    hours: Math.floor(minutes / 60),
    minutes: new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }).format(
      minutes % 60,
    ),
  });
}
