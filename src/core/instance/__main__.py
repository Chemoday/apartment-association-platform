"""The startup step of entrypoint.sh:  python -m src.core.instance [show]

A module of its own, so that `python -m` never runs the model module as __main__: that would
define core_instance a second time as soon as anything imports src.core.instance (the check
imports src.core.files, which reaches src.core.instance through module property).
"""

import asyncio
import json
import sys

import structlog

from src.core.config import settings
from src.core.instance import InstanceRefused, describe, run_check
from src.core.telemetry import configure_logging

logger = structlog.get_logger("src.core.instance")


def main(argv: list[str]) -> int:
    configure_logging(level=settings.LOG_LEVEL, json_logs=settings.LOG_JSON)
    if argv == ["show"]:
        print(json.dumps(asyncio.run(describe(settings))))
        return 0
    if argv:
        print("usage: python -m src.core.instance [show]", file=sys.stderr)
        return 2
    try:
        marker = asyncio.run(run_check(settings))
    except InstanceRefused as refused:
        logger.error("instance_check_refused", reason=refused.reason.value, found=refused.found)
        return 1
    logger.info(
        "instance_claimed" if marker.claimed_now else "instance_checked",
        instance_id=marker.instance_id,
        demo=marker.demo,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
