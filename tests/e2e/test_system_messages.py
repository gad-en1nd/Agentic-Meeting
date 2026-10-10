"""真实 HTTP/RTVI/存储回读：受控来源、旧数据库、坏来源与外部诊断。"""

from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

from .inference import Reply
from .waiting import until


@pytest.mark.parametrize(
    ("method", "path", "body", "status", "code", "params"),
    [
        ("GET", "/api/unknown", None, 404, "error.request.not_found", {}),
        ("POST", "/api/offer", [], 400, "error.connection.offer_invalid", {}),
        ("GET", "/api/sessions/missing", None, 404, "error.session.not_found", {}),
        ("GET", "/api/tasks/missing", None, 404, "error.task.not_found", {}),
        ("GET", "/api/frames?session_id=missing", None, 404, "error.session.not_found", {}),
        ("GET", "/api/utterances?tail=wrong", None, 422, "error.request.invalid", {}),
        ("GET", "/api/export/missing.csv", None, 404, "error.export.format_invalid", {}),
        ("POST", "/api/auth/login", {"password": "x"}, 404, "error.auth.disabled", {}),
    ],
)
async def test_http_errors_are_controlled(app, http, method, path, body, status, code, params):
    response = await http.request(method, path, json=body)
    assert response.status_code == status
    data = response.json()
    assert data["code"] == code and data["params"] == params
    assert isinstance(data["error"], str)
    assert "wrong" not in data["error"] and "missing" not in data["error"]


async def test_typed_limits_and_diar_startup_do_not_stop_captions(
    start_app, inference, meeting_factory, tmp_path
):
    fake_model = tmp_path / "fictional-diar-model.bin"
    fake_model.write_bytes(b"not a model")
    app = await start_app(
        {
            "diarization.backend": "nemo_ctypes",
            "diarization.library_path": "fictional-missing-diar-library",
            "diarization.model_path": str(fake_model),
        }
    )
    async with app.http() as http:
        client = meeting_factory(http)()
        session = await client.connect()
        degraded = await client.next_message("notice", code="notice.diar.unavailable")
        assert degraded["params"] == {} and "fictional" not in degraded["text"]
        client.type_text("x" * 2001)
        limited = await client.next_message("notice", code="notice.text.too_long")
        assert limited["params"] == {"max": 2000}
        inference.asr.say("受控提示之后继续转录")
        await client.speak()
        assert (await client.next_message("utterance"))["text"] == "受控提示之后继续转录"
        invalid = await http.patch(f"/api/sessions/{session['id']}", json={"title": "x" * 201})
        assert invalid.status_code == 400
        assert invalid.json()["code"] == "error.session.title_too_long"
        assert invalid.json()["params"] == {"max": 200}


async def test_task_fallback_timeout_and_cancel_have_persisted_sources(
    start_app, inference, meeting_factory
):
    app = await start_app({"agent.task_timeout_secs": 10})
    async with app.http() as http:
        client = meeting_factory(http)()
        await client.connect()
        inference.llm.when(
            "整理", Reply(tool="delegate_task", arguments={"goal": "整理虚构结论"}), sticky=True
        )
        inference.agent.when("整理虚构结论", Reply(text="没有 JSON 的原始正文"), sticky=True)
        client.type_text("Jarvis 整理一下")
        done = await client.next_message("task", status="succeeded", timeout_secs=60)
        assert done["brief_message"] == {"code": "task.result.fallback", "params": {}}
        detail = (await http.get(f"/api/tasks/{done['id']}")).json()
        assert detail["brief_message"] == done["brief_message"]
        assert detail["detail_md"] == "没有 JSON 的原始正文"
        client.messages.clear()
        inference.agent.delay_secs = 15
        client.type_text("Jarvis 再整理一下")
        failed = await client.next_message("task", status="failed", timeout_secs=60)
        assert failed["error_message"] == {"code": "task.failure.timeout", "params": {"minutes": 1}}
        detail = (await http.get(f"/api/tasks/{failed['id']}")).json()
        assert detail["error_message"] == failed["error_message"]
        client.messages.clear()
        client.type_text("Jarvis 再次整理一下")
        running = await client.next_message("task", status="running", timeout_secs=60)
        cancelled = await http.post(f"/api/tasks/{running['id']}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["error_message"] == {"code": "task.failure.cancelled", "params": {}}
        streamed = await client.next_message("task", status="cancelled")
        assert streamed["last_event"] == cancelled.json()["last_event"]


async def test_report_timeout_and_empty_transcript_sources(start_app, inference, meeting_factory):
    app = await start_app(report_timeout_secs=1)
    async with app.http() as http:
        client = meeting_factory(http)()
        empty = await client.connect()
        await http.post(f"/api/sessions/{empty['id']}/end")
        assert (await http.post(f"/api/sessions/{empty['id']}/report")).status_code == 202

        async def finished(sid):
            report = (await http.get(f"/api/sessions/{sid}/report")).json()
            return report if report["status"] != "running" else None

        no_transcript = await until(lambda: finished(empty["id"]), "空会议报告失败")
        assert no_transcript["error_message"] == {
            "code": "report.failure.no_transcript",
            "params": {},
        }
        client = meeting_factory(http)()
        session = await client.connect()
        inference.asr.say("超时报告的虚构素材")
        await client.speak()
        await client.next_message("utterance")
        await http.post(f"/api/sessions/{session['id']}/end")

        async def digest_ready():
            exported = (await http.get(f"/api/export/{session['id']}.json")).json()
            return exported["digests"]

        await until(digest_ready, "结束后的真实滚动纪要已完成")
        inference.llm.delay_secs = 3
        assert (await http.post(f"/api/sessions/{session['id']}/report")).status_code == 202
        timed_out = await until(lambda: finished(session["id"]), "报告超时")
        assert timed_out["error_message"] == {"code": "report.failure.timeout", "params": {}}
        assert timed_out["error"] == "生成超时"
        assert any(
            "你在为一场课题组组会写会后报告" in json.dumps(request, ensure_ascii=False)
            for request in inference.llm.started_requests
        )
        continued = meeting_factory(http)()
        await continued.connect()
        inference.asr.say("报告超时后字幕继续")
        await continued.speak()
        assert (await continued.next_message("utterance"))["text"] == "报告超时后字幕继续"

        async def late_response():
            return any(
                "你在为一场课题组组会写会后报告" in json.dumps(request, ensure_ascii=False)
                for request in inference.llm.requests
            )

        await until(late_response, "被取消报告的延迟上游已经返回")
        await asyncio.sleep(0.2)
        assert (await http.get(f"/api/sessions/{session['id']}/report")).json() == timed_out


async def test_old_database_and_bad_metadata_preserve_original_content(
    start_app, inference, meeting_factory
):
    first = await start_app()
    async with first.http() as http:
        client = meeting_factory(http)()
        session = await client.connect()
        client.type_text("数据库兼容性测试的原文")
        await client.next_message("utterance", source="text")
        await http.post(f"/api/sessions/{session['id']}/end")
    await first.shutdown()
    database = first.data_dir / "meetings.db"
    with sqlite3.connect(database) as db:
        db.execute(
            "INSERT INTO reports(session_id,created_at,status,text_md,error,write_token,finished_at) VALUES(?,1,'done','原始报告正文',NULL,'old-done',1)",
            (session["id"],),
        )
        cursor = db.execute(
            "INSERT INTO reports(session_id,created_at,status,text_md,error,write_token,finished_at) VALUES(?,2,'failed','','历史中文原始错误','old-failed',2)",
            (session["id"],),
        )
        report_id = cursor.lastrowid
        db.execute("ALTER TABLE reports DROP COLUMN error_message_json")
        for label, status, brief, error in [
            ("t1", "succeeded", "任务已完成，详情见任务面板", None),
            ("t2", "failed", None, "超时（超过 1 分钟没有做完）"),
            ("t3", "failed", None, "服务停止，任务没有做完"),
        ]:
            db.execute(
                "INSERT INTO tasks(id,session_id,goal,status,brief,error,created_at,finished_at,requested_t) VALUES(?,?,?,?,?,?,1,12,0)",
                (session["id"] + "." + label, session["id"], "虚构目标", status, brief, error),
            )
        payload = {
            "message": {"code": "task.event.failed", "params": {}},
            "error_message": {"code": "task.failure.timeout", "params": {"minutes": 3}},
            "task_status": "failed",
            "task_finished_at": 12,
        }
        for reference in [
            payload,
            {**payload, "error_message": {"code": "task.failure.shutdown", "params": {}}},
            {
                **payload,
                "task_finished_at": 13,
                "error_message": {"code": "report.failure.timeout", "params": {}},
                "arguments": {"private": "not-for-wire"},
            },
        ]:
            db.execute(
                "INSERT INTO task_events(task_id,at,kind,summary,payload_json) VALUES(?,12,'status','原始事件',?)",
                (session["id"] + ".t3", json.dumps(reference)),
            )
        db.execute(
            "INSERT INTO task_events(task_id,at,kind,summary,payload_json) VALUES(?,12,'note','损坏来源的原始内容','{bad-json')",
            (session["id"] + ".t2",),
        )
    second = await start_app(data_dir=first.data_dir)
    async with second.http() as http:
        report = (await http.get(f"/api/sessions/{session['id']}/report")).json()
        assert report["error"] == "历史中文原始错误" and report["error_message"] is None
        exported = (await http.get(f"/api/export/{session['id']}.json")).json()
        assert exported["report"]["text_md"] == "原始报告正文"
        assert "error_message" not in exported["report"]
        assert (await http.get(f"/api/sessions/{session['id']}/report.md")).text == "原始报告正文"
        items = (await http.get("/api/tasks", params={"session_id": session["id"]})).json()["items"]
        assert items[0]["brief_message"] is None
        assert (
            items[1]["error_message"] is None
            and items[1]["last_event"]["summary"] == "损坏来源的原始内容"
        )
        assert items[2]["error_message"] == {"code": "task.failure.shutdown", "params": {}}
        detail = (await http.get(f"/api/tasks/{session['id']}.t3")).json()
        assert detail["error_message"] == items[2]["error_message"]
        assert "arguments" not in json.dumps(detail["events"])
        assert "private" not in json.dumps(detail["events"])
        invalid = [
            "{bad-json",
            json.dumps({"code": "unknown.code", "params": {}}),
            json.dumps({"code": "task.failure.timeout", "params": {"minutes": 1}}),
            json.dumps({"code": "report.failure.timeout", "params": []}),
            json.dumps({"code": "report.failure.timeout", "params": {"extra": "secret"}}),
        ]
        for raw in invalid:
            with sqlite3.connect(database) as db:
                db.execute("UPDATE reports SET error_message_json=? WHERE id=?", (raw, report_id))
            report = (await http.get(f"/api/sessions/{session['id']}/report")).json()
            assert report["error_message"] is None and report["error"] == "历史中文原始错误"
        client = meeting_factory(http)()
        await client.connect()
        inference.asr.say("坏来源不影响下一场字幕")
        await client.speak()
        assert (await client.next_message("utterance"))["text"] == "坏来源不影响下一场字幕"
    await second.shutdown()
    third = await start_app(data_dir=first.data_dir)
    async with third.http() as http:
        report = (await http.get(f"/api/sessions/{session['id']}/report")).json()
        assert report["error_message"] is None and report["error"] == "历史中文原始错误"
    with sqlite3.connect(database) as db:
        assert [row[1] for row in db.execute("PRAGMA table_info(reports)")].count(
            "error_message_json"
        ) == 1
        assert db.execute(
            "SELECT text_md,write_token FROM reports WHERE status='done'"
        ).fetchone() == ("原始报告正文", "old-done")


@pytest.mark.parametrize("changed", ["write_token", "session_id", "none"])
async def test_report_late_work_respects_identity_and_success_clears_metadata(
    start_app, inference, meeting_factory, changed
):
    app = await start_app()
    async with app.http() as http:
        meetings = meeting_factory(http)
        client = meetings()
        session = await client.connect()
        client.type_text("晚到报告的虚构素材")
        await client.next_message("utterance", source="text")
        await http.post(f"/api/sessions/{session['id']}/end")
        other = meetings()
        other_session = await other.connect()
        await http.post(f"/api/sessions/{other_session['id']}/end")
        inference.llm.delay_secs = 1
        response = await http.post(f"/api/sessions/{session['id']}/report")
        assert response.status_code == 202
        report_id = response.json()["report_id"]
        with sqlite3.connect(app.data_dir / "meetings.db") as db:
            db.execute(
                "UPDATE reports SET error='既有错误',error_message_json=? WHERE id=?",
                (json.dumps({"code": "report.failure.timeout", "params": {}}), report_id),
            )
            if changed == "write_token":
                db.execute(
                    "UPDATE reports SET write_token='new-owner-token' WHERE id=?", (report_id,)
                )
            elif changed == "session_id":
                db.execute(
                    "UPDATE reports SET session_id=? WHERE id=?", (other_session["id"], report_id)
                )
        target = other_session["id"] if changed == "session_id" else session["id"]
        if changed == "none":

            async def done():
                body = (await http.get(f"/api/sessions/{target}/report")).json()
                return body if body["status"] == "done" else None

            completed = await until(done, "报告成功且清空旧错误")
            assert completed["error"] is None and completed["error_message"] is None
        else:
            # 等真实延迟上游返回，旧 identity 的成功/失败回调都不能覆盖新持有者。
            async def returned():
                return [
                    request
                    for request in inference.llm.requests
                    if "你在为一场课题组组会写会后报告" in json.dumps(request, ensure_ascii=False)
                ]

            await until(returned, "报告的真实延迟 HTTP 请求已返回")
            await asyncio.sleep(0.2)
            report = (await http.get(f"/api/sessions/{target}/report")).json()
            assert report["status"] == "running" and report["text_md"] == ""
            assert report["error"] == "既有错误"
            assert report["error_message"] == {"code": "report.failure.timeout", "params": {}}
        client = meetings()
        await client.connect()
        inference.asr.say("报告身份校验后字幕继续")
        await client.speak()
        assert (await client.next_message("utterance"))["text"] == "报告身份校验后字幕继续"


@pytest.mark.parametrize("max_turns", [1, 5])
async def test_sdk_tool_progress_is_bounded_and_never_projects_arguments(
    start_app, inference, meeting_factory, max_turns
):
    app = await start_app(
        {
            "agent.max_turns": max_turns,
            "agent.mcp_servers": [
                {"name": "虚构检索", "url": inference.mcp.origin + "/mcp", "headers_env": {}}
            ],
        }
    )
    async with app.http() as http:
        client = meeting_factory(http)()
        await client.connect()
        inference.llm.when(
            "查资料", Reply(tool="delegate_task", arguments={"goal": "检索虚构记录"})
        )
        inference.agent.when(
            "检索虚构记录",
            Reply(
                tool="search",
                arguments={
                    "query": "查找 " + "虚构" * 40,
                    "private": "private-tool-argument",
                    "message": {"code": "task.event.succeeded", "params": {}},
                },
            ),
        )
        client.type_text("Jarvis 查资料")
        terminal = await client.next_message(
            "task", status="failed" if max_turns == 1 else "succeeded", timeout_secs=60
        )
        detail = (await http.get(f"/api/tasks/{terminal['id']}")).json()
        events = detail["events"]
        called = next(e for e in events if e["kind"] == "tool_call")
        assert called["message"]["code"] == "task.tool.search"
        assert len(called["message"]["params"]["query"]) == 61
        returned = next(e for e in events if e["kind"] == "tool_result")
        assert returned["message"]["code"] == "task.tool.result"
        assert isinstance(returned["message"]["params"]["chars"], int)
        assert "private-tool-argument" not in json.dumps(events)
        assert "arguments" not in json.dumps(events)
        assert any(r["method"] == "tools/call" for r in inference.mcp.requests)
        if max_turns == 1:
            assert terminal["error_message"] == {
                "code": "task.failure.turn_limit",
                "params": {"maxTurns": 1},
            }
        assert terminal["last_event"] == detail["last_event"]
        client.type_text("工具任务以后文字字幕继续")
        assert (await client.next_message("utterance", text="工具任务以后文字字幕继续"))[
            "source"
        ] == "text"


async def test_terminal_event_storage_failure_keeps_status_and_captions(
    start_app, inference, meeting_factory
):
    app = await start_app()
    async with app.http() as http:
        client = meeting_factory(http)()
        await client.connect()
        inference.agent.delay_secs = 5
        inference.llm.when("后台", Reply(tool="delegate_task", arguments={"goal": "虚构后台任务"}))
        client.type_text("Jarvis 后台整理")
        running = await client.next_message("task", status="running", timeout_secs=60)
        with sqlite3.connect(app.data_dir / "meetings.db") as db:
            db.execute(
                "CREATE TRIGGER fictional_event_failure BEFORE INSERT ON task_events "
                "BEGIN SELECT RAISE(FAIL, 'fictional event persistence failure'); END"
            )
        cancelled = (await http.post(f"/api/tasks/{running['id']}/cancel")).json()
        assert cancelled["status"] == "cancelled" and cancelled["error_message"] is None
        streamed = await client.next_message("task", status="cancelled")
        assert streamed["error_message"] is None
        assert (await http.get(f"/api/tasks/{running['id']}")).json()["status"] == "cancelled"
        inference.asr.say("事件保存失败后字幕继续")
        await client.speak()
        assert (await client.next_message("utterance", text="事件保存失败后字幕继续"))[
            "text"
        ] == "事件保存失败后字幕继续"


async def test_restart_sources_only_attach_to_unfinished_work(start_app, meeting_factory):
    first = await start_app()
    async with first.http() as http:
        client = meeting_factory(http)()
        session = await client.connect()
        await http.post(f"/api/sessions/{session['id']}/end")
    await first.shutdown()
    database = first.data_dir / "meetings.db"
    with sqlite3.connect(database) as db:
        db.execute(
            "INSERT INTO reports(session_id,created_at,status,error,write_token) VALUES(?,1,'running','原始错误','recovery-token')",
            (session["id"],),
        )
        for label, status in [("t1", "running"), ("t2", "queued"), ("t3", "failed")]:
            db.execute(
                "INSERT INTO tasks(id,session_id,goal,status,error,created_at,requested_t,finished_at) VALUES(?,?,?,?,?,1,0,?)",
                (
                    session["id"] + "." + label,
                    session["id"],
                    "虚构目标",
                    status,
                    "历史原文",
                    7 if status == "failed" else None,
                ),
            )
    second = await start_app(data_dir=first.data_dir)
    async with second.http() as http:
        report = (await http.get(f"/api/sessions/{session['id']}/report")).json()
        assert report["status"] == "failed"
        assert report["error_message"] == {"code": "report.failure.interrupted", "params": {}}
        for label in ("t1", "t2"):
            task = (await http.get(f"/api/tasks/{session['id']}.{label}")).json()
            assert task["status"] == "failed"
            assert task["error_message"] == {"code": "task.failure.restart", "params": {}}
            assert task["last_event"]["id"] == task["events"][-1]["id"]
        historical = (await http.get(f"/api/tasks/{session['id']}.t3")).json()
        assert historical["error"] == "历史原文" and historical["error_message"] is None
        assert historical["finished_at"] == 7 and historical["events"] == []


async def test_text_queue_messages_keep_limits_and_fifo(start_app, inference, meeting_factory):
    app = await start_app()
    async with app.http() as http:
        client = meeting_factory(http)()
        await client.connect()
        inference.llm.delay_secs = 0.6
        client.type_text("Jarvis 队列第0条")

        async def started():
            return any(
                "队列第0条" in json.dumps(body, ensure_ascii=False)
                for body in inference.llm.started_requests
            )

        await until(started, "第一条文字请求已经进入真实模型 HTTP")
        for n in range(1, 6):
            client.type_text(f"Jarvis 队列第{n}条")
            await client.next_message("notice", code="notice.text.queued", params={"position": n})
        client.type_text("Jarvis 队列第6条")
        queued = await client.next_message("notice", code="notice.text.queued")
        full = await client.next_message("notice", code="notice.text.queue_full")
        assert queued["params"] == {"position": 1} and full["params"] == {"max": 5}

        async def drained():
            texts = inference.llm.texts()
            return texts if any("队列第5条" in text for text in texts) else None

        texts = await until(drained, "五条排队请求按 FIFO 完成")
        matching = [
            next(n for n in range(6) if f"队列第{n}条" in text)
            for text in texts
            if "队列第" in text
        ]
        assert matching == list(range(6))
        assert not any("队列第6条" in text for text in texts)
        inference.asr.say("队列结束后字幕继续")
        await client.speak()
        assert (await client.next_message("utterance", text="队列结束后字幕继续"))[
            "text"
        ] == "队列结束后字幕继续"


@pytest.mark.parametrize("service", ["llm", "tts"])
async def test_unknown_service_errors_are_generic_and_captions_continue(
    app, http, meeting, inference, service
):
    client = meeting()
    await client.connect()
    getattr(inference, service).status_code = 418
    inference.asr.say("Jarvis 请回应这句虚构内容")
    await client.speak()
    notice = await client.next_message("notice", code=f"notice.{service}.unknown")
    assert notice["params"] == {}
    assert "fake-external" not in notice["text"] and "418" not in notice["text"]
    inference.asr.say("未知服务错误后字幕继续")
    await client.speak()
    assert (await client.next_message("utterance", text="未知服务错误后字幕继续"))["id"]


async def test_mcp_degradation_separates_bounded_name_from_original_diagnostic(
    start_app, inference, meeting_factory
):
    name = "fictional-search-" + "x" * 70
    app = await start_app(
        {
            "agent.mcp_servers": [
                {"name": name, "url": inference.mcp.origin + "/mcp", "headers_env": {}}
            ]
        }
    )
    inference.mcp.down = True
    async with app.http() as http:
        client = meeting_factory(http)()
        await client.connect()
        inference.llm.when("检索", Reply(tool="delegate_task", arguments={"goal": "虚构检索目标"}))
        client.type_text("Jarvis 检索一下")
        task = await client.next_message("task", status="succeeded", timeout_secs=60)
        detail = (await http.get(f"/api/tasks/{task['id']}")).json()
        note = next(
            event
            for event in detail["events"]
            if event.get("message", {}).get("code") == "task.mcp.unavailable"
        )
        assert note["message"]["params"] == {"name": name[:60] + "…"}
        assert isinstance(note["diagnostic"], str) and len(note["diagnostic"]) <= 200
        assert note["diagnostic"].startswith("UserError: Failed to connect to MCP server")
        assert "arguments" not in note and "payload" not in note
        streamed = await client.next_message("task_event", id=note["id"])
        assert (
            streamed["message"] == note["message"] and streamed["diagnostic"] == note["diagnostic"]
        )
        inference.asr.say("检索降级后字幕继续")
        await client.speak()
        assert (await client.next_message("utterance", text="检索降级后字幕继续"))["id"]
