"""仍从正式 CLI 启动真实应用；仅缩短固定报告超时，避免测试等待十五分钟。"""

import os

from agentic_meeting.cli import main
from agentic_meeting.pipeline.report import ReportWorker

if __name__ == "__main__":
    ReportWorker.__init__.__kwdefaults__["timeout_secs"] = float(
        os.environ["E2E_REPORT_TIMEOUT_SECS"]
    )
    main()
