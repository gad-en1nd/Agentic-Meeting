import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installMedia } from "./media.ts";
import { stopServer, waitForServer, type ServerExit } from "./server.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export const test = base.extend<{ serverURL: string }>({
  serverURL: async ({}, use, info) => {
    const python = path.join(
      root,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const child = spawn(python, ["-m", "tests.browser.server"], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const logPath = info.outputPath("server.log");
    const log = createWriteStream(logPath);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const closed = new Promise<ServerExit>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      const url = await waitForServer(child);
      await use(url);
    } finally {
      try {
        await stopServer(child, closed);
      } finally {
        log.end();
        await once(log, "finish");
        await info.attach("server", { path: logPath, contentType: "text/plain" });
      }
    }
  },
  baseURL: async ({ serverURL }, use) => use(serverURL),
  context: async ({ context, serverURL, browserName }, use) => {
    const external: string[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith(serverURL + "/") || url.startsWith("blob:") || url.startsWith("data:")) {
        await route.continue();
      } else {
        external.push(url);
        await route.abort("blockedbyclient");
      }
    });
    await context.addInitScript(installMedia, { nativeAudio: browserName === "firefox" });
    await use(context);
    expect(external, "页面不应请求外部服务").toEqual([]);
  },
});
export { expect };

/**
 * 等受控管线处理完第 ``count`` 次 client-ready。页面显示「已连接」只说明浏览器发出了 client-ready，
 * 服务端可能还没挂上这一路连接（docs/pipecat-notes.md §12），这时推字幕会得到 409。
 */
export async function serverReady(request: APIRequestContext, count: number) {
  await expect
    .poll(async () => (await (await request.get("/__test/state")).json()).ready)
    .toBe(count);
}

/** 推一条受控字幕；服务端拒绝时立即失败并给出原因，而不是等字幕出现超时。 */
export async function emit(request: APIRequestContext, data: { text: string; final?: boolean }) {
  const response = await request.post("/__test/emit", { data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** 同一 peer 持续收到非静音帧；检查实际 sender，避免把 SDK 临时权限探针误当当前麦克风。 */
export async function expectMicrophoneFlow(page: Page, request: APIRequestContext) {
  const localTrack = () =>
    page.evaluate(() => {
      const media = (window as any).e2eMedia;
      const peer: RTCPeerConnection | undefined = media.peers.at(-1);
      const track = peer?.getSenders().find((sender) => sender.track?.kind === "audio")?.track;
      return track
        ? {
            state: track.readyState,
            enabled: track.enabled,
            captured: media.tracks.includes(track),
          }
        : null;
    });
  await expect.poll(localTrack).toEqual({ state: "live", enabled: true, captured: true });
  const before = await (await request.get("/__test/state")).json();
  expect(before.peer_state).toBe("connected");
  await expect
    .poll(async () => {
      const now = await (await request.get("/__test/state")).json();
      return now.peer_id === before.peer_id ? now.non_silent_frames - before.non_silent_frames : 0;
    })
    .toBeGreaterThanOrEqual(5);
  await expect.poll(localTrack).toEqual({ state: "live", enabled: true, captured: true });
}

/** 直接观察远端原生音轨的 PCM，不以播放元素的 paused 状态代替有声证据。 */
export async function botAudioProbe(page: Page) {
  await page.locator("audio").evaluate(async (element: HTMLAudioElement) => {
    if (!(element.srcObject instanceof MediaStream)) throw new Error("助理没有远端音轨");
    const context = new AudioContext();
    const source = context.createMediaStreamSource(element.srcObject);
    const analyser = context.createAnalyser();
    source.connect(analyser);
    await context.resume();
    Object.assign(window, { e2eBotAudio: { context, analyser, source } });
  });
  return {
    level: () =>
      page.evaluate(() => {
        const analyser: AnalyserNode = (window as any).e2eBotAudio.analyser;
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.max(...samples.map(Math.abs));
      }),
    close: () =>
      page.evaluate(async () => {
        const probe = (window as any).e2eBotAudio;
        probe.source.disconnect();
        await probe.context.close();
      }),
  };
}
