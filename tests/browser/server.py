"""真实 HTTP/SQLite/WebRTC，只有推理输入由受控测试管线替代。"""

from __future__ import annotations

import asyncio
import os
import socket
import tempfile
import time
import tomllib
from dataclasses import asdict
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pipecat.frames.frames import Frame, InputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi.frames import RTVIServerMessageFrame
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner
from starlette.routing import Mount

from agentic_meeting.agent.tasks import task_dir, task_message
from agentic_meeting.config import EXAMPLE_CONFIG_PATH, AppConfig
from agentic_meeting.messages import event_json, notice_message, task_metadata
from agentic_meeting.pipeline.bot import AppResources, session_message
from agentic_meeting.store.db import Store
from agentic_meeting.types import Utterance
from agentic_meeting.web.app import create_app
from agentic_meeting.web.tasks_api import task_json


def configuration(root: Path) -> AppConfig:
    """只读模板；不读取用户配置、环境文件或启动模型。"""
    data = tomllib.loads(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
    data["session"]["data_dir"] = str(root)
    data["session"]["members"] = ["林晓", "周远"]
    cfg = AppConfig.model_validate(data)
    cfg.agent.enabled = cfg.embedding.enabled = cfg.tts.enabled = False
    cfg.screen.caption = False
    cfg.server.ice_servers = []
    cfg.server.password_env = (
        "BROWSER_TEST_PASSWORD" if os.environ.get("BROWSER_TEST_AUTH") == "1" else ""
    )
    return cfg


async def seed(store: Store, root: Path) -> dict[str, Any]:
    """每个测试独占数据库，两个会议的内容刻意不同。"""
    now = time.time()
    ended = await store.create_session("星河项目复盘", now=now - 300)
    interrupted = await store.create_session("月面计划讨论", now=now - 60)
    for session, texts in (
        (ended, ["星河测试第一条发言", "星河测试第二条发言"]),
        (interrupted, ["月面计划保留的历史字幕"]),
    ):
        for idx, text in enumerate(texts, 1):
            await store.add_utterance(Utterance(session.id, idx, idx, idx + 1, text))
            await store.rename_speaker(session.id, idx, f"测试同学{idx}")
    await store.end_session(ended.id, now=now - 200)
    frame = await store.add_frame(
        ended.id, t=3, width=320, height=180, suffix=".png", caption_status="skipped"
    )
    path = root / frame.path
    path.parent.mkdir(parents=True)
    Image.new("RGB", (320, 180), "#234567").save(path)
    task = await store.create_task(ended.id, goal="整理星河测试结论", requested_t=4)
    await store.update_task(
        task.id,
        status="succeeded",
        brief="已整理虚构结论",
        detail_md="## 星河测试结果\n只包含虚构会议内容。",
        artifacts=["result.txt"],
        finished_at=now,
    )
    directory = task_dir(root, task)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "result.txt").write_text("星河测试产物\n", encoding="utf-8")
    # 再交办两个目标和结论都较长的任务，看板放不下时要能看出各区域怎么分高度。
    for goal, brief in (
        (
            "逐条核对星河测试里提到的四组虚构数据各自的采集日期和来源，"
            "每组用一两句话说明结论，最后汇总哪些数据需要重新采集，结果用中文回答。",
            "四组虚构数据里有三组是上周采集的，第四组更早，来源都已补全；"
            "建议重新采集第四组，其余可以直接用于下一轮星河测试。",
        ),
        (
            "比较星河测试前后两轮虚构结果的差异，列出变化最大的三项指标并说明可能的原因，"
            "结果用中文回答。",
            "变化最大的是虚构指标甲、乙、丙，主要原因是第二轮换了采集设备；"
            "其余指标的差异都在误差范围内，不需要额外处理。",
        ),
    ):
        extra = await store.create_task(ended.id, goal=goal, requested_t=5)
        await store.update_task(extra.id, status="succeeded", brief=brief, finished_at=now)
    return {"ended": ended.id, "interrupted": interrupted.id, "task": task.id, "frame": frame.id}


async def seed_localization(store: Store) -> dict[str, Any]:
    """通过真实 Store 保存可信来源和历史原文，HTTP 仍走生产投影。"""
    clock = 1_700_000_000.0
    session = await store.create_session("语言测试原始会议", now=clock)
    connection = await store.open_connection(session.id, connected_at=clock, t_from=0)
    await store.close_connection(connection, disconnected_at=clock + 3601, t_to=3601)
    await store.end_session(session.id, now=clock + 3601)
    await store.add_utterance(Utterance(session.id, 1, 0, 1, "原始中文字幕不翻译"))
    await store.rename_speaker(session.id, 1, "原始中文姓名")
    tasks = {}
    for index, (name, status, seconds, reason) in enumerate(
        (
            ("failed", "failed", 61, {"code": "task.failure.timeout", "params": {"minutes": 2}}),
            ("cancelled", "cancelled", 59, {"code": "task.failure.cancelled", "params": {}}),
            ("running", "running", None, None),
            ("fallback", "succeeded", 3601, None),
            ("legacy", "failed", 0, None),
        )
    ):
        task = await store.create_task(
            session.id,
            goal=f"原始中文目标 {name}",
            requested_by=1,
            requested_t=2,
            now=clock + index,
        )
        finished_at = clock + seconds if seconds is not None else None
        error = "原始外部诊断：fictional failure" if status == "failed" else None
        if name == "cancelled":
            error = "已取消"
        await store.update_task(
            task.id,
            status=status,
            started_at=clock,
            finished_at=finished_at,
            error=error,
            brief="任务已完成，详情见任务面板" if name == "fallback" else "",
            detail_md="## 原始中文模型结果\n不随界面语言改写。",
        )
        if name != "legacy":
            await store.add_task_event(
                task.id,
                "tool_call",
                "正在检索「原始检索片段」",
                {
                    "message": {"code": "task.tool.search", "params": {"query": "原始检索片段"}},
                    "tool": "fictional-tool",
                    "arguments": {"private": "不应透传的原始参数"},
                },
                now=clock + index,
            )
            if seconds is not None:
                payload = {
                    "message": {"code": f"task.event.{status}", "params": {}},
                    "task_status": status,
                    "task_finished_at": finished_at,
                }
                if reason is not None:
                    payload["error_message"] = reason
                if name == "failed":
                    payload["diagnostic"] = "原始外部诊断：fictional failure"
                if name == "fallback":
                    payload["brief_message"] = {"code": "task.result.fallback", "params": {}}
                await store.add_task_event(
                    task.id, "status", "原始兼容终态文案", payload, now=finished_at
                )
        else:
            await store.add_task_event(task.id, "status", "历史原始进度", now=clock)
        tasks[name] = task.id
    reports, report_sessions = {}, {}
    for index, status in enumerate(("failed", "running", "done", "legacy"), 1):
        report_session = await store.create_session(
            f"原始报告会议 {status}", now=clock + index * 10
        )
        await store.end_session(report_session.id, now=clock + index * 10 + 59)
        report_id = await store.create_report(report_session.id, provider="agent_llm", now=clock)
        if status in {"failed", "legacy"}:
            await store.fail_report(
                report_id,
                "原始报告诊断：fictional report failure",
                now=clock + 1,
                error_message={"code": "report.failure.timeout", "params": {}}
                if status == "failed"
                else None,
            )
        elif status == "done":
            await store.finish_report(
                report_id, "# 原始中文报告\n模型正文保留原文。", now=clock + 1
            )
        reports[status] = report_id
        report_sessions[status] = report_session.id
    under = await store.create_session("短于一分钟", now=clock + 100)
    connection = await store.open_connection(under.id, connected_at=clock + 100, t_from=0)
    await store.close_connection(connection, disconnected_at=clock + 159, t_to=59)
    await store.end_session(under.id, now=clock + 159)
    wall = time.time() - 100
    interrupted = await store.create_session("中断五十九秒", now=wall)
    for connected_at, disconnected_at, t_from, t_to in (
        (wall, wall + 10, 0, 10),
        (wall + 69, wall + 79, 69, 79),
    ):
        connection = await store.open_connection(
            interrupted.id, connected_at=connected_at, t_from=t_from
        )
        await store.close_connection(connection, disconnected_at=disconnected_at, t_to=t_to)
        await store.add_utterance(
            Utterance(interrupted.id, 1, t_from, t_from + 1, f"跨中断原始字幕 {t_from}")
        )
    return {
        "session": session.id,
        "tasks": tasks,
        "reports": reports,
        "reportSessions": report_sessions,
        "spans": {
            "sessionUnderMinute": under.id,
            "sessionHour": session.id,
            "interruption59": interrupted.id,
        },
        "clock": clock,
    }


class AudioProbe(FrameProcessor):
    """计数真实接收的 PCM，证明麦克风轨道确实经过 WebRTC。"""

    def __init__(self, base_secs: float) -> None:
        super().__init__()
        self.elapsed_secs = base_secs
        self.audio_frames = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.audio_frames += 1
            self.elapsed_secs += len(frame.audio) / (2 * frame.num_channels * frame.sample_rate)
        await self.push_frame(frame, direction)

    def set_speaker_name(self, _idx: int, _name: str) -> None:
        """名字由真实 Store 和 SessionManager 管理。"""


class ControlledBot:
    """保留 Pipecat 管线、RTVI、连接生命周期；不建立 ASR/LLM/TTS。"""

    def __init__(self) -> None:
        self.ready = 0
        self.segment = 0
        self.probe: AudioProbe | None = None

    async def __call__(self, connection: Any, request: Any, resources: AppResources) -> None:
        manager = resources.sessions
        assert manager is not None
        wanted = request.get("session_id") if isinstance(request, dict) else None
        live = await manager.attach(wanted) if wanted else await manager.begin()
        self.segment = live.connection_id * 1000 + 1
        try:
            transport = SmallWebRTCTransport(
                webrtc_connection=connection,
                params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
            )
            self.probe = probe = AudioProbe(live.base_secs)
            worker = PipelineWorker(
                Pipeline([transport.input(), probe, transport.output()]),
                params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000),
                idle_timeout_secs=None,
            )

            @worker.rtvi.event_handler("on_client_ready")
            async def ready(_rtvi: Any) -> None:
                self.ready += 1
                await worker.queue_frame(
                    RTVIServerMessageFrame(
                        data=session_message(live.session, live.resumed, live.base_secs)
                    )
                )
                if resources.cfg.session.recording_notice:
                    await worker.queue_frame(
                        RTVIServerMessageFrame(data=notice_message("info", "notice.recording"))
                    )

            @transport.event_handler("on_client_disconnected")
            async def disconnected(_transport: Any, _connection: Any) -> None:
                await worker.cancel()

            await manager.register(live, worker, probe)
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            await runner.run()
        finally:
            await manager.finish(live)


def application(cfg: AppConfig, store: Store, seeds: dict[str, Any]) -> FastAPI:
    bot = ControlledBot()
    app = create_app(
        cfg,
        store=store,
        bot=bot,
        static_dir=Path(__file__).resolve().parents[2] / "client" / "dist",
    )
    control = FastAPI()
    localization_task_id: str | None = None

    @control.get("/state")
    async def state() -> dict[str, Any]:
        live = app.state.resources.sessions.live
        return {
            **seeds,
            "live": live.session.id if live else None,
            "ready": bot.ready,
            "audio_frames": bot.probe.audio_frames if bot.probe else 0,
        }

    @control.post("/emit")
    async def emit(body: dict[str, Any]) -> dict[str, Any]:
        resources = app.state.resources
        live = resources.sessions.live
        if live is None:
            raise HTTPException(409, "没有活动测试连接")
        text = str(body.get("text", "受控实时字幕"))
        t = max(live.base_secs, bot.probe.elapsed_secs)
        segment = bot.segment
        message = {
            "segment_id": segment,
            "speaker_idx": 1,
            "speaker_name": await store.speaker_name(live.session.id, 1),
            "t_start": t,
        }
        if not body.get("final", True):
            await resources.sessions.push(
                {"type": "caption", **message, "stable": text, "unstable": ""}
            )
            return {"segment_id": segment}
        bot.segment += 1
        utterance = Utterance(live.session.id, 1, t, t + 0.1, text)
        await store.add_utterance(utterance)
        await resources.sessions.push(
            {
                "type": "utterance",
                **message,
                "id": utterance.id,
                "t_end": t + 0.1,
                "text": text,
                "source": "asr",
            }
        )
        return asdict(utterance)

    @control.post("/message")
    async def message(body: dict[str, Any]) -> dict[str, bool]:
        resources = app.state.resources
        if resources.sessions.live is None:
            raise HTTPException(409, "没有活动测试连接")
        data = body.get("message")
        if not isinstance(data, dict):
            raise HTTPException(400, "需要测试消息对象")
        await resources.sessions.push(data)
        return {"sent": True}

    @control.post("/seed-localization")
    async def localization() -> dict[str, Any]:
        return await seed_localization(store)

    @control.post("/localization-task")
    async def localization_task(body: dict[str, Any]) -> dict[str, Any]:
        """先保存真实来源，再返回仅供坏消息测试发送的原始 wire。"""
        nonlocal localization_task_id
        resources = app.state.resources
        phase = body.get("phase")
        now = time.time()
        wire = None
        if phase == "seed":
            if resources.sessions.live is not None or localization_task_id is not None:
                raise HTTPException(409, "测试任务必须在连接前创建一次")
            session = await store.create_session("实时任务语言测试", now=now)
            task = await store.create_task(session.id, goal="原始实时目标", now=now)
            task = await store.update_task(task.id, status="running", started_at=now)
            assert task is not None
            localization_task_id = task.id
            event = await store.add_task_event(
                task.id,
                "tool_call",
                "正在检索「初始检索片段」",
                {"message": {"code": "task.tool.search", "params": {"query": "初始检索片段"}}},
                now=now,
            )
        elif phase in {"progress", "failed"}:
            task = await store.get_task(str(body.get("task_id", "")))
            live = resources.sessions.live
            if (
                task is None
                or task.id != localization_task_id
                or live is None
                or live.session.id != task.session_id
                or task.status != "running"
            ):
                raise HTTPException(409, "需要正在连接的原始测试任务")
            if phase == "progress":
                bad = {"code": "notice.recording", "params": {}}
                event = await store.add_task_event(
                    task.id,
                    "tool_call",
                    "原始未知进度 <img src=x>",
                    {"message": bad},
                    now=now,
                )
                wire = {
                    "type": "task_event",
                    "task_id": task.id,
                    **event_json(event),
                    "message": bad,
                }
            else:
                task = await store.update_task(
                    task.id,
                    status="failed",
                    error="不应作为系统模板的中文错误",
                    finished_at=now,
                )
                assert task is not None
                bad = {"code": "task.failure.timeout", "params": {"minutes": "2"}}
                event = await store.add_task_event(
                    task.id,
                    "status",
                    "任务失败",
                    {
                        "message": {"code": "task.event.failed", "params": {}},
                        "task_status": task.status,
                        "task_finished_at": task.finished_at,
                        "error_message": bad,
                    },
                    now=now,
                )
                wire = {
                    **task_message(
                        task, task_metadata(task, await store.list_task_events(task.id))
                    ),
                    "error_message": bad,
                    "last_event": None,
                }
        else:
            raise HTTPException(400, "测试阶段必须是 seed、progress 或 failed")
        return {
            "session": task.session_id,
            "task": await task_json(store, task),
            "event": event_json(event),
            "wire": wire,
        }

    # 放在生产静态站点之前；生产 create_app 从未挂载这些路由。
    app.router.routes.insert(0, Mount("/__test", app=control))
    return app


class ReadyServer(uvicorn.Server):
    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets)
        if self.started:
            assert sockets
            print(f"E2E_READY http://127.0.0.1:{sockets[0].getsockname()[1]}", flush=True)


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="agentic-meeting-e2e-") as temp:
        root = Path(temp)
        cfg = configuration(root)
        store = await Store.open(root / "meetings.db", cfg.embedding.dimensions)
        try:
            seeds = await seed(store, root)
            app = application(cfg, store, seeds)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                server = ReadyServer(
                    uvicorn.Config(app, log_level="info", timeout_graceful_shutdown=10)
                )
                await server.serve(sockets=[sock])
        finally:
            await store.close()


if __name__ == "__main__":
    asyncio.run(main())
