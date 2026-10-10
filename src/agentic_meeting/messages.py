"""界面的受控系统消息：只保存来源，不按兼容原文猜测（interfaces.md §5.9）。"""

from __future__ import annotations

import math
import string
from typing import Any

from starlette.exceptions import HTTPException

from agentic_meeting.types import TaskEvent, TaskRecord

TEXTS = {
    "notice.llm.auth": "助理暂不可用：密钥被拒绝，请检查配置里的密钥变量",
    "notice.llm.not_found": "助理暂不可用：接口地址或模型名不对（404）",
    "notice.llm.rate_limited": "助理暂不可用：被服务端限流了，稍后再试",
    "notice.llm.server": "助理暂不可用：服务端出错（{status}）",
    "notice.llm.timeout": "助理暂不可用：请求超时",
    "notice.llm.connection": "助理暂不可用：连不上服务",
    "notice.llm.unknown": "助理暂不可用：未知错误",
    "notice.tts.auth": "语音不可用，助理这次只出文字：密钥被拒绝，请检查配置里的密钥变量",
    "notice.tts.not_found": "语音不可用，助理这次只出文字：接口地址或模型名不对（404）",
    "notice.tts.rate_limited": "语音不可用，助理这次只出文字：被服务端限流了，稍后再试",
    "notice.tts.server": "语音不可用，助理这次只出文字：服务端出错（{status}）",
    "notice.tts.timeout": "语音不可用，助理这次只出文字：请求超时",
    "notice.tts.connection": "语音不可用，助理这次只出文字：连不上服务",
    "notice.tts.unknown": "语音不可用，助理这次只出文字：未知错误",
    "notice.generic": "服务暂时不可用，请稍后重试",
    "notice.recording": "会议正在转录，发言和共享画面会保存在服务器上",
    "notice.microphone.low": "麦克风音量过低，请调高系统的输入音量或靠近麦克风",
    "notice.diar.unavailable": "说话人区分不可用，所有发言将记为「未知」，不分说话人",
    "notice.diar.failed": "说话人区分出错，之后的发言将记为「未知」",
    "notice.diar.renumbered": "服务重启过，说话人编号可能与之前不同；认错的可以在说话人那里用「合并到…」收拾",
    "notice.asr.unavailable": "识别服务暂时不可用，正在重试",
    "notice.asr.recovered": "识别服务已恢复",
    "notice.text.invalid": "文字消息的格式不对，没有发送",
    "notice.text.empty": "消息是空的，没有发送",
    "notice.text.too_long": "消息太长（最多 {max} 字），没有发送",
    "notice.text.queue_full": "助理正忙，排队已满（{max} 条），这条消息没有发送",
    "notice.text.queued": "助理正忙，这条消息排在第 {position} 位，稍后回答",
    "error.request.failed": "请求失败",
    "error.request.not_found": "没有这个接口或页面",
    "error.request.invalid": "请求格式有误",
    "error.request.json_required": "请求体必须是 JSON",
    "error.request.object_required": "请求体必须是 JSON 对象",
    "error.request.too_large": "请求体太大",
    "error.storage.not_ready": "存储尚未就绪",
    "error.cleanup.not_ready": "清理尚未就绪",
    "error.session.not_found": "找不到这场会议",
    "error.session.no_current": "现在没有会议",
    "error.session.busy": "会议正在处理或等待删除，请稍后重试",
    "error.session.delete_failed": "删除未完成，会议待删除，请稍后重试",
    "error.session.id_invalid": "session_id 必须是非空的字符串",
    "error.session.patch_fields_invalid": "只接受 title、keep，至少给一个",
    "error.session.title_invalid": "title 必须是字符串",
    "error.session.title_too_long": "标题太长（最多 {max} 字）",
    "error.session.keep_invalid": "keep 必须是布尔值",
    "error.connection.offer_invalid": "WebRTC 请求格式有误",
    "error.connection.fatal": "会议连接失败，请重新连接",
    "error.auth.required": "请先登录",
    "error.auth.csrf": "请求缺少有效的安全令牌，请刷新页面后重试",
    "error.auth.wrong_password": "口令不对",
    "error.auth.rate_limited": "尝试次数过多，请稍后再试",
    "error.auth.disabled": "没有启用访问口令",
    "error.auth.body_too_large": "请求体太大",
    "error.auth.body_invalid": '请求体应为 {"password": "..."}',
    "error.utterance.pagination_invalid": "after_id、before_id、tail 只能给一个",
    "error.utterance.ids_invalid": "ids 必须是非空的发言编号列表",
    "error.utterance.speaker_choice_invalid": "speaker_idx 和 new_speaker 要给一个，且只给一个",
    "error.utterance.too_many": "一次最多改 {max} 条发言",
    "error.speaker.index_invalid": "speaker_idx 必须是说话人编号（助理和文字输入不能当发言人）",
    "error.speaker.not_found": "这场会议里没有这个说话人",
    "error.speaker.name_invalid": "名字必须是非空的字符串",
    "error.speaker.name_too_long": "名字太长（最多 {max} 字）",
    "error.speaker.merge_target_invalid": "into 必须是说话人编号（整数）",
    "error.speaker.merge_kind_invalid": "只能合并说话人区分给出的说话人（助理、文字输入、「未知」不能合并）",
    "error.speaker.merge_self": "不能把说话人合并到自己",
    "error.frame.disabled": "截图功能已在配置里关闭",
    "error.frame.no_live": "现在没有进行中的会议，截图没有保存",
    "error.frame.captured_at_invalid": "captured_at 必须是数字（Unix 秒）",
    "error.frame.not_found": "找不到这张截图",
    "error.frame.format_invalid": "只接受 WebP 或 JPEG 格式的截图",
    "error.frame.image_invalid": "上传的文件不是有效的图片",
    "error.frame.empty": "上传的文件是空的",
    "error.frame.save_failed": "截图保存失败（磁盘不可写？）",
    "error.frame.side_too_large": "截图的长边不能超过 {maxSide} 像素",
    "error.frame.body_too_large": "截图太大（最多 {maxMB} MB）",
    "error.frame.time_skew": "截图的采集时间与服务端时间相差超过 {maxSecs:.0f} 秒，请刷新页面重新对时",
    "error.task.not_found": "找不到这个任务",
    "error.task.disabled": "后台任务功能没有开启",
    "error.task.artifact_not_found": "找不到这个产物文件",
    "error.report.live": "会议正在进行，结束或断开之后才能生成报告",
    "error.report.no_model": "没有可用的模型，生成不了报告",
    "error.report.running": "这场会议已经有一份报告正在生成",
    "error.report.not_found": "这场会议还没有报告",
    "error.report.not_ready": "这场会议还没有生成好的报告",
    "error.export.format_invalid": "导出地址的格式是 /api/export/<会议编号>.md（或 .json、.zip）",
    "task.event.started": "开始处理",
    "task.event.succeeded": "已完成",
    "task.event.failed": "任务失败",
    "task.event.cancelled": "已取消",
    "task.event.unknown": "任务进度",
    "task.result.fallback": "任务已完成，详情见任务面板",
    "task.tool.search": "正在检索「{query}」",
    "task.tool.open": "正在打开「{url}」",
    "task.tool.call": "正在调用工具 {name}",
    "task.mcp.unavailable": "检索服务 {name} 连不上，这次不用它",
    "task.tool.result": "工具返回了结果（约 {chars} 字）",
    "task.tool.empty": "工具没有返回内容",
    "task.tool.error": "工具返回了错误",
    "task.tool.code_timeout": "代码运行超时",
    "task.sandbox.exec": "正在运行一段代码",
    "task.sandbox.input": "正在向运行中的程序输入",
    "task.sandbox.write": "正在写文件",
    "task.sandbox.image": "正在查看图片",
    "task.sandbox.exec_done": "代码运行完成",
    "task.sandbox.input_done": "输入完成",
    "task.sandbox.write_done": "文件已写好",
    "task.sandbox.image_done": "图片看完了",
    "task.sandbox.unavailable": "代码执行环境不可用，这次只能检索和读图",
    "task.failure.timeout": "超时（超过 {minutes} 分钟没有做完）",
    "task.failure.turn_limit": "步骤太多（超过 {maxTurns} 步）还没有做完",
    "task.failure.remote_status": "远端模型返回了错误（{status}）",
    "task.failure.cancelled": "已取消",
    "task.failure.shutdown": "服务停止，任务没有做完",
    "task.failure.restart": "服务重启，任务没有做完",
    "task.failure.disabled": "后台任务功能已在配置里关闭",
    "task.failure.not_configured": "后台 agent 还没有配置",
    "task.failure.dependency": "没有安装后台 agent 的依赖（uv sync --extra agent）",
    "task.failure.auth": "远端模型不接受密钥，请检查配置",
    "task.failure.connection": "连不上远端模型",
    "task.failure.runtime": "agent 运行出错",
    "task.failure.unknown": "任务执行失败",
    "report.failure.timeout": "生成超时",
    "report.failure.interrupted": "服务停止了，这份报告没有生成完",
    "report.failure.no_model": "没有可用的模型，生成不了报告",
    "report.failure.no_transcript": "这场会议没有发言记录，写不出报告",
    "report.failure.session_missing": "找不到这场会议",
    "report.failure.unknown": "报告生成失败",
}
# JSON 示例的花括号不是插值。
PARAMS = {
    code: {field for _, field, _, _ in string.Formatter().parse(text) if field}
    for code, text in TEXTS.items()
    if code != "error.auth.body_invalid"
}
PARAMS["error.auth.body_invalid"] = set()
STRING_PARAMS = {"query", "url", "name"}


def validate_reference(raw: Any, prefixes: tuple[str, ...] = ()) -> dict[str, Any] | None:
    """只投影已声明的标量参数，坏数据不影响消息流。"""
    if not isinstance(raw, dict) or set(raw) - {"code", "params"}:
        return None
    code, params = raw.get("code"), raw.get("params", {})
    if (
        not isinstance(code, str)
        or code not in PARAMS
        or (prefixes and not code.startswith(prefixes))
    ):
        return None
    if not isinstance(params, dict) or set(params) != PARAMS[code]:
        return None
    for name, value in params.items():
        if name in STRING_PARAMS:
            if not isinstance(value, str) or not value.strip() or len(value) > 61:
                return None
            continue
        if (
            type(value) not in (int, float)
            or not -1_000_000_000 <= value <= 1_000_000_000
            or not math.isfinite(value)
        ):
            return None
        if name == "maxSecs":
            if not 0 < value <= 1_000_000:
                return None
        else:
            lower, upper = (
                (0, 1_000_000_000) if name == "chars" else (0 if name == "maxMB" else 1, 1_000_000)
            )
            if name == "status":
                lower, upper = (500, 599) if code.startswith("notice.") else (100, 599)
            if value != int(value) or not lower <= value <= upper:
                return None
    return {"code": code, "params": dict(params)}


def reference(code: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    ref = validate_reference({"code": code, "params": params if params is not None else {}})
    if ref is not None:
        return ref
    # 超出显示边界仍保留原业务限制，不能让提示中断任务或字幕。
    fallback = (
        "notice.generic"
        if code.startswith("notice.")
        else "error.request.failed"
        if code.startswith("error.")
        else "report.failure.unknown"
        if code.startswith("report.failure.")
        else "task.failure.unknown"
        if code.startswith("task.failure.")
        else "task.event.unknown"
    )
    return {"code": fallback, "params": {}}


def text(ref: dict[str, Any]) -> str:
    template = TEXTS[ref["code"]]
    return template.format(**ref["params"]) if ref["params"] else template


def error_body(code: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    ref = validate_reference(
        {"code": code, "params": params if params is not None else {}}, ("error.",)
    )
    ref = ref or reference("error.request.failed")
    return {"error": text(ref), **ref}


def http_error(status: int, code: str, params: dict[str, Any] | None = None) -> HTTPException:
    return HTTPException(status, error_body(code, params))


def notice_message(level: str, code: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    ref = validate_reference(
        {"code": code, "params": params if params is not None else {}}, ("notice.",)
    )
    ref = ref or reference("notice.generic")
    return {"type": "notice", "level": level, "text": text(ref), **ref}


def event_json(event: TaskEvent) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": event.id,
        "at": event.at,
        "kind": event.kind,
        "summary": event.summary,
    }
    payload = event.payload if isinstance(event.payload, dict) else {}
    for field, families in (
        ("message", ("task.event.", "task.tool.", "task.sandbox.", "task.mcp.")),
        ("error_message", ("task.failure.",)),
        ("brief_message", ("task.result.fallback",)),
    ):
        ref = validate_reference(payload.get(field), families)
        if ref is not None:
            result[field] = ref
    diagnostic = payload.get("diagnostic")
    if isinstance(diagnostic, str) and len(diagnostic) <= 200:
        result["diagnostic"] = diagnostic
    return result


def task_metadata(task: TaskRecord, events: list[TaskEvent]) -> dict[str, Any]:
    result: dict[str, Any] = {"error_message": None, "brief_message": None, "last_event": None}
    for event in sorted(events, key=lambda e: e.id, reverse=True):
        projected = event_json(event)
        if result["last_event"] is None:
            result["last_event"] = projected
        payload = event.payload if isinstance(event.payload, dict) else {}
        if (
            task.finished
            and payload.get("task_status") == task.status
            and type(payload.get("task_finished_at")) in (int, float)
            and payload["task_finished_at"] == task.finished_at
        ):
            expected = {
                "succeeded": "task.event.succeeded",
                "failed": "task.event.failed",
                "cancelled": "task.event.cancelled",
            }[task.status]
            if event.kind == "status" and projected.get("message", {}).get("code") == expected:
                field = "brief_message" if task.status == "succeeded" else "error_message"
                result[field] = projected.get(field)
                break
    return result
