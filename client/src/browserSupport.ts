import { translate, type Locale, type MessageRef } from "./i18n.ts";
/**
 * 浏览器能不能开会（docs/user-guide.md「支持的浏览器」）。
 *
 * 最低版本同时是 vite.config.ts 里的构建目标：比它旧的浏览器连脚本都解析不了，由 index.html 里的兜底脚本提示。
 * 这里只查版本够新、但开会要用的接口拿不到的情况，最常见的是没通过 HTTPS 打开。
 */

/** 支持的浏览器及最低版本；`target` 是给构建工具的写法。 */
export const MIN_BROWSERS = [
  { name: "Chrome", version: "111", target: "chrome111" },
  { name: "Edge", version: "111", target: "edge111" },
  { name: "Firefox", version: "114", target: "firefox114" },
  { name: "Safari", version: "16.4", target: "safari16.4" },
] as const;

/** 「Chrome 111、Edge 111、Firefox 114、Safari 16.4」 */
export function minBrowsersText(locale: Locale = "zh-CN"): string {
  return MIN_BROWSERS.map((b) => `${b.name} ${b.version}`).join(
    translate(locale, "ui.browser.listSeparator"),
  );
}

/** 只取用到的几个属性，方便在不同全局对象上检查。 */
export interface BrowserEnv {
  isSecureContext: boolean;
  RTCPeerConnection?: unknown;
  AudioContext?: unknown;
  navigator: { mediaDevices?: { getUserMedia?: unknown } };
}

/** 能开会返回 null；否则返回给用户看的原因（只读地看历史会议不受影响）。 */
export function meetingUnsupportedReason(env: BrowserEnv = window): MessageRef | null {
  // 不是 HTTPS 也不是 localhost 时浏览器直接不给麦克风接口，先说这个，换浏览器没用。
  if (!env.isSecureContext) {
    return { code: "ui.browser.insecure" };
  }
  const missing: string[] = [];
  if (typeof env.RTCPeerConnection !== "function") missing.push("WebRTC");
  if (typeof env.navigator.mediaDevices?.getUserMedia !== "function") missing.push("getUserMedia");
  if (typeof env.AudioContext !== "function") missing.push("Web Audio");
  if (missing.length === 0) return null;
  return {
    code: "ui.browser.missing",
    params: {
      features: missing.join(", "),
      browsers: MIN_BROWSERS.map((browser) => `${browser.name} ${browser.version}`).join(", "),
    },
  };
}
