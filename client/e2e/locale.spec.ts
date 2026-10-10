import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, emit, serverReady } from "./fixtures.ts";

const storageKey = "agentic-meeting.ui-language";

async function language(page: Page, value: "auto" | "zh-CN" | "en") {
  await page.locator(".language-selector select").last().selectOption(value);
  if (value !== "auto") await expect(page.locator("html")).toHaveAttribute("lang", value);
}

async function view(page: Page, title: string) {
  await page.getByRole("button", { name: /^(会议列表|Meeting list)$/ }).click();
  await page.locator(".session-main").filter({ hasText: title }).click();
  await expect(page.locator(".banner-title")).toHaveText(title);
}

async function message(request: APIRequestContext, value: Record<string, unknown>) {
  const response = await request.post("/__test/message", { data: { message: value } });
  expect(response.status(), await response.text()).toBe(200);
}

for (const [languages, locale] of [
  [["zh-TW", "en-US"], "zh-CN"],
  [["fr-FR", "EN-gb", "zh-CN"], "en"],
  [["fr-FR"], "zh-CN"],
  [[], "zh-CN"],
] as const) {
  test(`浏览器语言 ${languages.join("/") || "empty"} 自动选择 ${locale}`, async ({ page }) => {
    await page.addInitScript((values) => {
      Object.defineProperty(navigator, "languages", { configurable: true, value: values });
      Object.defineProperty(navigator, "language", { configurable: true, value: "fr-FR" });
    }, languages);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page).toHaveTitle(locale === "en" ? "Agentic Meeting" : "组会助理");
    await expect(page.locator(".language-selector select")).toHaveValue("auto");
    await expect(
      page.getByRole("heading", { name: locale === "en" ? "Agentic Meeting" : "组会助理" }),
    ).toBeVisible();
  });
}

test("手动选择重载保留，自动模式跟随 languagechange，坏存储值回自动", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await language(page, "zh-CN");
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.evaluate(() => window.dispatchEvent(new Event("languagechange")));
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await language(page, "auto");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["zh-HK"] });
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await language(page, "en");
  await page.evaluate(() => window.dispatchEvent(new Event("languagechange")));
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.evaluate((key) => localStorage.setItem(key, "unsupported"), storageKey);
  await page.reload();
  await expect(page.locator(".language-selector select")).toHaveValue("auto");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("存储读写被拒绝仍可切换当前页面，会议原文不受影响", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (key: string, ...args: string[]) {
        if (key === "agentic-meeting.ui-language")
          throw new DOMException("fictional storage denial", "SecurityError");
        return original.apply(this, [key, ...args] as never);
      };
    }
  });
  await page.goto("/");
  await language(page, "en");
  await expect(page.getByRole("heading", { name: "Agentic Meeting" })).toBeVisible();
  await expect(page.getByText("月面计划保留的历史字幕", { exact: true })).toBeVisible();
  await language(page, "auto");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await language(page, "en");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

for (const mode of ["manual", "automatic", "storage-denied"] as const) {
  test(`主模块失败的 ES5 提示同 catalog 且使用 ${mode} 语言规则`, async ({ page }) => {
    await page.addInitScript((choice) => {
      Object.defineProperty(navigator, "languages", {
        value: choice === "manual" ? ["zh-CN"] : ["fr-FR", "en-US"],
      });
      if (choice === "manual") localStorage.setItem("agentic-meeting.ui-language", "en");
      if (choice === "storage-denied")
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("denied", "SecurityError");
          },
        });
    }, mode);
    await page.route(/\/assets\/.*\.js$/, (route) =>
      route.fulfill({ contentType: "text/javascript", body: "export const broken = ;" }),
    );
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("The page could not start.");
    await expect(page.getByRole("alert")).toContainText("Chrome 111");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("Agentic Meeting");
  });
}

test("英文能力提示和已有错误即时切换，历史只读且不发 offer", async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  await page.goto("/");
  await language(page, "en");
  await expect(page.getByRole("alert")).toContainText("lacks the WebRTC APIs");
  await page.getByRole("button", { name: "Meeting list", exact: true }).click();
  await page.getByRole("button", { name: "Resume: 月面计划讨论", exact: true }).click();
  await expect(page.locator(".notice-error")).toContainText("lacks the WebRTC APIs");
  await language(page, "zh-CN");
  await expect(page.locator(".notice-error")).toContainText("缺少WebRTC接口");
  const state = await (await request.get("/__test/state")).json();
  expect(state).toMatchObject({ ready: 0, live: null });
  await expect(page.getByText("月面计划保留的历史字幕", { exact: true })).toBeVisible();
});

test("连接中切换已有系统提示，字幕、输入、选中发言和媒体连接保持", async ({ page, request }) => {
  const offers: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/offer") && req.method() === "POST") offers.push(req.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "会议列表", exact: true }).click();
  await page.getByRole("button", { name: "继续：月面计划讨论", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("已连接");
  await serverReady(request, 1);
  await emit(request, { text: "界面切换前的原始字幕" });
  const input = page.getByRole("textbox", { name: "给助理发文字消息" });
  await input.fill("尚未发送的原始问题");
  await page
    .getByRole("button", { name: /选中 .* 在 .* 的发言/ })
    .first()
    .click();
  await message(request, {
    type: "notice",
    level: "warn",
    code: "notice.text.queued",
    params: { position: 1234 },
    text: "不应主导显示的旧中文",
  });
  await expect(page.locator(".notice-warn").last()).toContainText("第 1,234 位");
  const before = await (await request.get("/__test/state")).json();
  const media = await page.evaluate(() =>
    (window as any).e2eMedia.tracks.map((track: MediaStreamTrack) => track.id),
  );
  await language(page, "en");
  await expect(page.locator(".notice-warn").last()).toContainText("number 1,234");
  await expect(page.locator(".notice-warn").last()).not.toContainText("不应主导显示");
  await expect(page.locator("textarea")).toHaveValue("尚未发送的原始问题");
  await expect(page.locator(".caption-selected")).toHaveCount(1);
  await expect(page.getByText("界面切换前的原始字幕", { exact: true })).toBeVisible();
  await emit(request, { text: "语言切换后继续到达的原始字幕", final: false });
  await expect(page.getByText("语言切换后继续到达的原始字幕", { exact: true })).toBeVisible();
  expect(offers).toHaveLength(1);
  const after = await (await request.get("/__test/state")).json();
  expect(after.ready).toBe(before.ready);
  expect(after.live).toBe(before.live);
  expect(after.audio_frames).toBeGreaterThanOrEqual(before.audio_frames);
  expect(
    await page.evaluate(() =>
      (window as any).e2eMedia.tracks.map((track: MediaStreamTrack) => track.id),
    ),
  ).toEqual(media);
  await page.locator(".notice-warn").last().getByRole("button", { name: "Dismiss notice" }).click();
  await language(page, "zh-CN");
  await expect(page.locator(".notices")).not.toContainText("第 1,234 位");
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("未连接");
});

test("未知、坏参数、跨 family 和旧消息仅显示通用提示且字幕继续", async ({ page, request }) => {
  await page.goto("/");
  await language(page, "en");
  await page.getByRole("button", { name: "Start new meeting", exact: true }).first().click();
  await expect(page.getByRole("status").first()).toHaveText("Connected");
  await serverReady(request, 1);
  const malformed = [
    {},
    { code: "notice.future" },
    { code: "error.auth.wrong_password" },
    { code: "notice.text.queued" },
    { code: "notice.text.queued", params: { position: "2" } },
    { code: "notice.text.queued", params: { position: 0 } },
    { code: "notice.text.queued", params: { position: 2, extra: 1 } },
    { code: "notice.text.queued", params: null },
    { code: "notice.text.queued", params: [] },
    { code: "notice.text.queued", params: { position: 1_000_001 } },
    { code: "notice.recording", params: { unexpected: "<img src=x onerror=alert(1)>" } },
  ];
  for (const [index, raw] of malformed.entries()) {
    await message(request, {
      type: "notice",
      level: "warn",
      text: "<script>legacy()</script>",
      ...raw,
    });
    await expect(page.locator(".notice-warn").last()).toContainText(
      "Service details are unavailable",
    );
    await emit(request, { text: `坏消息之后的字幕 ${index}` });
    await expect(page.getByText(`坏消息之后的字幕 ${index}`, { exact: true })).toBeVisible();
  }
  await message(request, {
    type: "notice",
    level: "invalid",
    code: "notice.recording",
    params: {},
  });
  await expect(page.locator(".notices")).not.toContainText("legacy()");
  await expect(page.locator(".notices script, .notices img")).toHaveCount(0);
  await expect(page.getByRole("status").nth(1)).toContainText(
    "Speech and shared screens are saved",
  );
  await page.getByRole("button", { name: "End meeting", exact: true }).click();
});

test("实时任务的坏来源安全降级，原始进度独立显示且可切换", async ({ page, request }) => {
  await page.goto("/");
  await language(page, "en");
  await page.getByRole("button", { name: "Start new meeting", exact: true }).first().click();
  await expect(page.getByRole("status").first()).toHaveText("Connected");
  await serverReady(request, 1);
  const live = (await (await request.get("/__test/state")).json()).live;
  const id = `${live}.fictional-task`;
  const task = {
    type: "task",
    id,
    label: "t-local",
    goal: "原始实时目标",
    status: "running",
    brief: null,
    error: null,
    modality: "voice",
    created_at: 1700000000,
  };
  await message(request, task);
  await message(request, {
    type: "task_event",
    task_id: id,
    id: 1,
    at: 1700000001,
    kind: "tool_call",
    summary: "原始未知进度 <img src=x>",
    message: { code: "notice.recording", params: {} },
  });
  const card = page.getByRole("button", { name: /原始实时目标/ });
  await expect(card).toContainText("Task progress details are unavailable.");
  await expect(card).toContainText("Original diagnostic: 原始未知进度 <img src=x>");
  await expect(card.locator("img")).toHaveCount(0);
  await language(page, "zh-CN");
  await expect(card).toContainText("任务进度暂不可用");
  await expect(card).toContainText("原始诊断：原始未知进度 <img src=x>");
  await message(request, {
    ...task,
    status: "failed",
    error: "不应作为系统模板的中文错误",
    error_message: { code: "task.failure.timeout", params: { minutes: "2" } },
    last_event: null,
  });
  await expect(card).toContainText("任务执行失败");
  await expect(card).not.toContainText("不应作为系统模板");
  await language(page, "en");
  await expect(card).toContainText("The task failed.");
  await emit(request, { text: "任务元数据坏了之后仍有字幕" });
  await expect(page.getByText("任务元数据坏了之后仍有字幕", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "End meeting", exact: true }).click();
});

test("任务系统来源和原文从真实 HTTP 回读，详情切换不关闭，保留各自秒精度", async ({
  page,
  request,
}) => {
  const response = await request.post("/__test/seed-localization", { data: {} });
  expect(response.status(), await response.text()).toBe(200);
  const seeds = await response.json();
  await page.goto("/");
  await language(page, "en");
  await view(page, "语言测试原始会议");
  const tasks = page.getByRole("region", { name: "Background tasks" });
  await expect(tasks).toContainText("Timed out after 2 minutes");
  await expect(tasks).toContainText("Searching for “原始检索片段”");
  await expect(tasks).toContainText("See the task panel");
  await tasks.getByRole("button", { name: /原始中文目标 failed/ }).click();
  const detail = page.getByRole("dialog", { name: /^Task / });
  await expect(detail).toContainText("Timed out after 2 minutes");
  await expect(detail).toContainText("Progress (duration: 1 min 01 s)");
  await expect(detail).toContainText("原始中文模型结果");
  await expect(detail).toContainText("Original diagnostic: 原始外部诊断");
  await expect(detail).not.toContainText("不应透传的原始参数");
  await language(page, "zh-CN");
  await expect(page.getByRole("dialog", { name: /^任务 / })).toContainText("用时 1 分 01 秒");
  await expect(page.getByRole("dialog", { name: /^任务 / })).toContainText(
    "超时（超过 2 分钟没有做完）",
  );
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await language(page, "en");
  for (const [name, duration] of [
    ["cancelled", "59 s"],
    ["fallback", "60 min 01 s"],
    ["legacy", "0 s"],
  ]) {
    await tasks.getByRole("button", { name: new RegExp(`原始中文目标 ${name}`) }).click();
    await expect(detail).toContainText(`Progress (duration: ${duration})`);
    if (name === "legacy") await expect(detail).toContainText("Original diagnostic: 历史原始进度");
    await detail.getByRole("button", { name: "Close", exact: true }).click();
  }
  const stored = await (await request.get(`/api/tasks/${seeds.tasks.failed}`)).json();
  expect(stored.goal).toBe("原始中文目标 failed");
  expect(stored.error_message).toEqual({ code: "task.failure.timeout", params: { minutes: 2 } });
  expect(stored.events.every((event: Record<string, unknown>) => !("payload" in event))).toBe(true);
});

test("会话分钟与中断秒精度来自真实连接跨度", async ({ page, request }) => {
  const response = await request.post("/__test/seed-localization", { data: {} });
  expect(response.status(), await response.text()).toBe(200);
  const seeds = await response.json();
  await page.goto("/");
  await language(page, "en");
  await view(page, "短于一分钟");
  await expect(page.locator(".banner-meta")).toContainText("Less than 1 min");
  await view(page, "语言测试原始会议");
  await expect(page.locator(".banner-meta")).toContainText("1 h 00 min");
  await view(page, "中断五十九秒");
  await expect(page.getByRole("separator")).toHaveText("— Interrupted for 59 s —");
  await language(page, "zh-CN");
  await expect(page.getByRole("separator")).toHaveText("— 中断了 59 秒 —");
  for (const name of ["sessionUnderMinute", "sessionHour", "interruption59"]) {
    const actual = await (await request.get(`/api/sessions/${seeds.spans[name]}`)).json();
    expect(actual.id).toBe(seeds.spans[name]);
  }
});

test("报告失败来源、历史诊断和模型正文在两语间保持原文", async ({ page, request }) => {
  const response = await request.post("/__test/seed-localization", { data: {} });
  expect(response.status(), await response.text()).toBe(200);
  const seeds = await response.json();
  await page.goto("/");
  await language(page, "en");
  await view(page, "原始报告会议 failed");
  await page.getByRole("tab", { name: "Report", exact: true }).click();
  const report = page.getByRole("region", { name: "Post-meeting report" });
  await expect(report).toContainText("Report generation timed out");
  await expect(report).not.toContainText("原始报告诊断");
  await language(page, "zh-CN");
  await expect(page.locator(".report-status, .report-head .notice-error")).toContainText("超时");
  await language(page, "en");
  await view(page, "原始报告会议 legacy");
  await expect(report).toContainText("Original diagnostic: 原始报告诊断");
  await view(page, "原始报告会议 running");
  await expect(report).toContainText("Generating a report with Remote background model");
  await view(page, "原始报告会议 done");
  await expect(report).toContainText("# 原始中文报告\n模型正文保留原文。");
  await language(page, "zh-CN");
  await expect(page.locator(".report-text")).toHaveText("# 原始中文报告\n模型正文保留原文。");
  const saved = await (
    await request.get(`/api/sessions/${seeds.reportSessions.done}/report`)
  ).json();
  expect(saved.text_md).toBe("# 原始中文报告\n模型正文保留原文。");
});

test("英文成员改名 ARIA、截图 alt 和打开的大图随语言切换，名字和图片不变", async ({
  page,
  request,
}) => {
  const seeds = await (await request.get("/__test/state")).json();
  await page.goto("/");
  await language(page, "en");
  await view(page, "星河项目复盘");
  const speakers = page.getByRole("group", { name: "Speakers", exact: true });
  await speakers.getByRole("button", { name: "测试同学1", exact: true }).click();
  await speakers.getByRole("button", { name: "Rename “测试同学1” to “林晓”" }).click();
  await expect(speakers.getByRole("button", { name: "林晓", exact: true })).toBeVisible();
  const img = page.getByRole("img", { name: "Screenshot at 00:00:03", exact: true });
  await img.click();
  const lightbox = page.getByRole("dialog", { name: "Screenshot", exact: true });
  await expect(lightbox.getByRole("img")).toHaveAttribute(
    "src",
    `/api/frames/${seeds.frame}/image`,
  );
  await language(page, "zh-CN");
  await expect(page.getByRole("dialog", { name: "屏幕截图", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("img")).toHaveAttribute(
    "src",
    `/api/frames/${seeds.frame}/image`,
  );
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page
      .getByRole("group", { name: "说话人", exact: true })
      .getByRole("button", { name: "林晓", exact: true }),
  ).toBeVisible();
  await language(page, "en");
  await expect(page.locator(".banner-meta")).toContainText("Utterances: 2");
  const date = await page.locator(".banner-meta").textContent();
  expect(date).not.toContain("月");
});

test("本地字数与 HTTP 失败按当前语言显示，不信任旧错误文字", async ({ page }) => {
  await page.route("**/api/sessions", async (route) => {
    const actual = await route.fetch();
    expect(actual.ok()).toBe(true);
    await route.fulfill({
      response: actual,
      status: 503,
      json: {
        error: "<img src=x onerror=alert(1)>",
        code: "error.session.title_too_long",
        params: { max: "invalid" },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator(".notice-error")).toContainText("请求失败（503）");
  await language(page, "en");
  await expect(page.locator(".notice-error")).toContainText("The request failed (503)");
  await expect(page.locator(".notices img")).toHaveCount(0);
  await page.unroute("**/api/sessions");
  await page.getByRole("button", { name: "Start new meeting", exact: true }).first().click();
  await expect(page.getByRole("status").first()).toHaveText("Connected");
  await page
    .getByRole("textbox", { name: "Send a text message to the assistant" })
    .fill("字".repeat(2001));
  await expect(page.locator(".text-input-over")).toHaveText("Characters over the limit: 1");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".notice-warn").last()).toContainText("maximum 2,000 characters");
  await language(page, "zh-CN");
  await expect(page.locator(".notice-warn").last()).toContainText("最多 2,000 字");
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
});

test("HTTP 参数边界按原整秒舍入，坏来源只显示状态说明", async ({ page }) => {
  let body: Record<string, unknown> = { code: "error.frame.time_skew", params: { maxSecs: 1.5 } };
  await page.route("**/api/sessions", async (route) => {
    const actual = await route.fetch();
    expect(actual.ok()).toBe(true);
    await route.fulfill({
      response: actual,
      status: 400,
      json: { error: "不应显示的旧异常", ...body },
    });
  });
  await page.goto("/");
  await language(page, "en");
  await expect(page.locator(".notice-error").last()).toContainText("more than 2 seconds");
  for (const [next, expected] of [
    [{ code: "error.frame.time_skew", params: { maxSecs: 2.5 } }, "more than 2 seconds"],
    [{ code: "error.frame.time_skew", params: { maxSecs: 2.6 } }, "more than 3 seconds"],
    [{ code: "error.frame.time_skew", params: { maxSecs: 0 } }, "The request failed (400)"],
    [{ code: "error.frame.time_skew", params: { maxSecs: 1000001 } }, "The request failed (400)"],
    [{ code: "notice.recording", params: {} }, "The request failed (400)"],
    [{ code: "error.unknown" }, "The request failed (400)"],
    [{}, "The request failed (400)"],
  ] as const) {
    body = next;
    const reply = page.waitForResponse((response) => response.url().endsWith("/api/sessions"));
    await page.getByRole("button", { name: "Meeting list", exact: true }).click();
    await reply;
    await expect(page.locator(".notice-error").last()).toContainText(expected);
    await expect(page.locator(".notices")).not.toContainText("不应显示的旧异常");
    await page.getByRole("button", { name: "Close meeting list", exact: true }).click();
  }
  await language(page, "zh-CN");
  await expect(page.locator(".notice-error").last()).toContainText("请求失败（400）");
});

test.describe("真实口令登录", () => {
  test.use({ authEnabled: true });

  test("登录错误即时翻译，真实限流 Retry-After 按分钟显示", async ({ page, request }) => {
    await page.goto("/");
    await page.getByLabel("访问口令", { exact: true }).fill("wrong-fictional-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("口令不对");
    await language(page, "en");
    await expect(page.getByRole("alert")).toHaveText("Incorrect password.");
    await expect(page.getByLabel("Access password", { exact: true })).toHaveValue(
      "wrong-fictional-password",
    );
    let status = 401;
    let retry = "";
    for (let index = 0; index < 12 && status !== 429; index += 1) {
      const response = await request.post("/api/auth/login", {
        data: { password: "wrong-fictional-password" },
      });
      status = response.status();
      retry = response.headers()["retry-after"] ?? "";
    }
    expect(status).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts. Retry in");
    await language(page, "zh-CN");
    await expect(page.getByRole("alert")).toContainText("分钟后再试");
  });

  test("真实 CSRF 和失效 overlay，不卸载会议连接或丢字幕", async ({ page, context }) => {
    const request = page.request;
    await page.goto("/");
    await language(page, "en");
    await page.getByLabel("Access password", { exact: true }).fill("fictional-browser-passphrase");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start new meeting", exact: true }).first(),
    ).toBeVisible();
    const auth = await (await request.get("/api/auth")).json();
    expect(auth.authenticated).toBe(true);
    const seeds = await (await request.get("/__test/state")).json();
    const denied = await request.patch(`/api/sessions/${seeds.interrupted}`, {
      data: { title: "禁止的测试改名" },
    });
    expect(denied.status()).toBe(403);
    expect((await denied.json()).code).toBe("error.auth.csrf");
    const accepted = await request.patch(`/api/sessions/${seeds.interrupted}`, {
      headers: { "X-CSRF-Token": auth.csrf_token },
      data: { title: "合法中文会议标题" },
    });
    expect(accepted.status()).toBe(200);
    await page.getByRole("button", { name: "Start new meeting", exact: true }).first().click();
    await expect(page.getByRole("status").first()).toHaveText("Connected");
    await serverReady(request, 1);
    await emit(request, { text: "登录失效前的真实字幕" });
    const before = await (await request.get("/__test/state")).json();
    await context.clearCookies();
    await page.getByRole("button", { name: "Meeting list", exact: true }).click();
    await expect(page.locator(".login-overlay")).toBeVisible();
    await expect(page.locator(".login-overlay")).toContainText("The meeting continues");
    await language(page, "zh-CN");
    await expect(page.locator(".login-overlay")).toContainText("会议不受影响");
    await expect(page.getByText("登录失效前的真实字幕", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").first()).toHaveText("已连接");
    await page
      .locator(".login-overlay")
      .getByLabel("访问口令", { exact: true })
      .fill("fictional-browser-passphrase");
    await page.locator(".login-overlay").getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".login-overlay")).toHaveCount(0);
    const after = await (await request.get("/__test/state")).json();
    expect(after.live).toBe(before.live);
    expect(after.ready).toBe(before.ready);
    await page.getByRole("button", { name: "关闭会议列表", exact: true }).click();
    await emit(request, { text: "重新登录后的真实字幕" });
    await expect(page.getByText("重新登录后的真实字幕", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "结束会议", exact: true }).click();
    await expect(page.getByRole("status").first()).toHaveText("未连接");
  });
});
