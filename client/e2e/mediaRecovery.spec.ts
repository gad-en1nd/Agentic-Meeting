import { test, expect, emit, serverReady, expectMicrophoneFlow } from "./fixtures.ts";

test("意外关闭真实 peer 后自动继续同一会议、保留字幕截图并恢复入站音频", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
  await serverReady(request, 1);
  const state = () => request.get("/__test/state").then((response) => response.json());
  const before = await state();
  const utterance = await emit(request, { text: "断线前保留的发言" });
  await expect(page.getByText("断线前保留的发言", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "共享屏幕", exact: true }).click();
  const panel = page.getByRole("region", { name: "屏幕", exact: true });
  await expect(panel.getByRole("img")).toHaveCount(1);
  const response = await request.post("/__test/disconnect");
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ peer_id: before.peer_id, state: "closed" });
  // SDK 重连未必再次发 client-ready；新 peer 和真实入站 PCM 才能证明传输恢复。
  await expect
    .poll(async () => (await state()).peer_id, { timeout: 60_000 })
    .not.toBe(before.peer_id);
  await expect.poll(async () => (await state()).peer_state, { timeout: 60_000 }).toBe("connected");
  await expectMicrophoneFlow(page, request);
  const after = await state();
  expect(after.live).toBe(before.live);
  expect(after.offer_sessions.length).toBeGreaterThan(before.offer_sessions.length);
  expect(after.offer_sessions.slice(before.offer_sessions.length)).toEqual(
    Array(after.offer_sessions.length - before.offer_sessions.length).fill(before.live),
  );
  await expect(page.getByRole("status").first()).toHaveText("已连接");
  await expect(page.getByText("断线前保留的发言", { exact: true })).toBeVisible();
  await expect(panel.getByRole("img").first()).toBeVisible();
  const next = await emit(request, { text: "断线后继续的发言" });
  expect(next.session_id).toBe(before.live);
  expect(next.t_start).toBeGreaterThanOrEqual(utterance.t_end);
  await expect(page.getByText("断线后继续的发言", { exact: true })).toBeVisible();
  const detail = await (await request.get(`/api/sessions/${before.live}`)).json();
  expect(detail.connections).toHaveLength(2);
  expect(detail.connections[0].disconnected_at).not.toBeNull();
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
  await expect(page.getByRole("status").first()).toHaveText("未连接");
});

test("SDK与页面重试耗尽后停止协商，恢复服务可手动继续同一会议", async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
  await serverReady(request, 1);
  const state = () => request.get("/__test/state").then((response) => response.json());
  const before = await state();
  expect((await request.post("/__test/offers", { data: { enabled: false } })).ok()).toBe(true);
  expect((await request.post("/__test/disconnect")).ok()).toBe(true);
  await expect(page.getByText(/自动重连没有成功/)).toBeVisible({ timeout: 100_000 });
  expect((await state()).live).toBeNull();
  const count = (await state()).offer_sessions.length;
  // 两层重试都应停下，不能在展示「继续」后仍暗中抢占连接。
  await expect(
    page.waitForRequest((req) => req.url().endsWith("/api/offer"), { timeout: 6000 }),
  ).rejects.toThrow(/Timeout/);
  expect((await state()).offer_sessions).toHaveLength(count);
  expect((await request.post("/__test/offers", { data: { enabled: true } })).ok()).toBe(true);
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect.poll(async () => (await state()).peer_state).toBe("connected");
  await expectMicrophoneFlow(page, request);
  expect((await state()).live).toBe(before.live);
  await expect(page.getByRole("status").first()).toHaveText("已连接");
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
});

test("被第二页面接管及主动结束后不自动抢回连接", async ({ page, context, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
  await serverReady(request, 1);
  const id = (await (await request.get("/__test/state")).json()).live;
  const observer = await context.newPage();
  try {
    await observer.goto("/");
    await expect(
      observer.getByRole("button", { name: "在这台设备上继续", exact: true }),
    ).toBeVisible();
    await observer.getByRole("button", { name: "在这台设备上继续", exact: true }).click();
    await serverReady(request, 2);
    await expect(page.getByRole("status").first()).toHaveText("未连接");
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).e2eMedia.tracks.every(
            (track: MediaStreamTrack) => track.readyState === "ended",
          ),
        ),
      )
      .toBe(true);
    await expect(observer.getByRole("status").first()).toHaveText("已连接");
    await expect(
      page.waitForRequest((req) => req.url().endsWith("/api/offer"), { timeout: 6000 }),
    ).rejects.toThrow(/Timeout/);
    const state = await (await request.get("/__test/state")).json();
    expect(state.live).toBe(id);
    expect(state.offer_sessions[0]).toBeNull();
    expect(state.offer_sessions.slice(1)).toEqual(Array(state.offer_sessions.length - 1).fill(id));
    await observer.getByRole("button", { name: "结束会议", exact: true }).click();
    await expect(observer.getByRole("status").first()).toHaveText("未连接");
    await expect
      .poll(() =>
        observer.evaluate(() =>
          (window as any).e2eMedia.tracks.every(
            (track: MediaStreamTrack) => track.readyState === "ended",
          ),
        ),
      )
      .toBe(true);
    await expect(
      observer.waitForRequest((req) => req.url().endsWith("/api/offer"), { timeout: 6000 }),
    ).rejects.toThrow(/Timeout/);
    const ended = await (await request.get("/__test/state")).json();
    expect(ended.live).toBeNull();
    expect(ended.offer_sessions).toEqual(state.offer_sessions);
  } finally {
    await observer.close();
  }
});

test("静止屏幕不重复上传、局部文字变化上传且静止满兜底间隔仍发心跳", async ({ page, request }) => {
  test.setTimeout(100_000);
  await page.goto("/");
  await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
  await serverReady(request, 1);
  const id = (await (await request.get("/__test/state")).json()).live;
  const frames = () =>
    request.get(`/api/frames?session_id=${id}`).then((response) => response.json());
  await page.getByRole("button", { name: "共享屏幕", exact: true }).click();
  await expect.poll(async () => (await frames()).items.length).toBe(1);
  const uploaded = (response: { url: () => string; request: () => { method: () => string } }) =>
    response.url().endsWith("/api/frames") && response.request().method() === "POST";
  await expect(page.waitForResponse(uploaded, { timeout: 3000 })).rejects.toThrow(/Timeout/);
  const first = (await frames()).items[0];
  const firstImage = await (await request.get(`/api/frames/${first.id}/image`)).body();
  await page.evaluate(() => (window as any).e2eMedia.changeScreenLocally());
  await expect.poll(async () => (await frames()).items.length).toBe(2);
  const changed = (await frames()).items[1];
  const changedImage = await (await request.get(`/api/frames/${changed.id}/image`)).body();
  expect(changedImage).not.toEqual(firstImage);
  expect(changed.t).toBeGreaterThan(first.t);
  // 保留真实默认 60 秒兜底间隔，不改生产配置或浏览器时钟。
  const heartbeat = await page.waitForResponse(uploaded, { timeout: 75_000 });
  expect(heartbeat.ok()).toBe(true);
  const items = (await frames()).items;
  expect(items).toHaveLength(3);
  expect(items[2].t - changed.t).toBeGreaterThanOrEqual(59);
  expect(await (await request.get(`/api/frames/${items[2].id}/image`)).body()).toEqual(
    changedImage,
  );
  await expect(
    page.getByRole("region", { name: "屏幕", exact: true }).getByRole("img"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
});

for (const action of ["结束", "断线"] as const) {
  test(`屏幕选择器等待期间${action}会议，晚到的原生轨道必须释放`, async ({ page, request }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
    await serverReady(request, 1);
    const frameRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith("/api/frames") && req.method() === "POST")
        frameRequests.push(req.url());
    });
    await page.evaluate(() => ((window as any).e2eMedia.screenPending = true));
    await page.getByRole("button", { name: "共享屏幕", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).e2eMedia.screenResolvers.length))
      .toBe(1);
    if (action === "结束")
      await page.getByRole("button", { name: "结束会议", exact: true }).click();
    else {
      // SDK 可在页面保持「已连接」时自愈；拒绝新 offer 才能观测真正持续的掉线。
      expect((await request.post("/__test/offers", { data: { enabled: false } })).ok()).toBe(true);
      expect((await request.post("/__test/disconnect")).ok()).toBe(true);
    }
    // 原生 ICE 检测之后还有 SDK 的 5 秒等待和三次协商退避；不是全局放宽断言。
    await expect(page.getByRole("status").first()).not.toHaveText("已连接", {
      timeout: action === "断线" ? 30_000 : 15_000,
    });
    await page.evaluate(() => (window as any).e2eMedia.releaseScreen());
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).e2eMedia.tracks
            .filter((track: MediaStreamTrack) => track.kind === "video")
            .every((track: MediaStreamTrack) => track.readyState === "ended"),
        ),
      )
      .toBe(true);
    expect(frameRequests).toEqual([]);
    await expect(page.getByRole("button", { name: "停止共享", exact: true })).toHaveCount(0);
  });
}

test("屏幕选择器等待期间重复点击只发起一次采集", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开始新会议", exact: true }).first().click();
  await serverReady(request, 1);
  await page.evaluate(() => ((window as any).e2eMedia.screenPending = true));
  await page.getByRole("button", { name: "共享屏幕", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).e2eMedia.screenResolvers.length))
    .toBe(1);
  // 直接触发用户按钮；按钮仍可点时，第二次调用应被生产 hook 的 pending 守卫挡住。
  await page.getByRole("button", { name: "共享屏幕", exact: true }).click();
  expect(await page.evaluate(() => (window as any).e2eMedia.displayCalls.length)).toBe(1);
  await page.evaluate(() => (window as any).e2eMedia.releaseScreen());
  await expect(page.getByRole("button", { name: "停止共享", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "结束会议", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).e2eMedia.tracks.every(
          (track: MediaStreamTrack) => track.readyState === "ended",
        ),
      ),
    )
    .toBe(true);
});
