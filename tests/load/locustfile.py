"""Load scenarios of one installation on its reading-deadline day (tests/load/README.md, #168).

    LOAD_USERS=users.json uv run --group load locust -f tests/load/locustfile.py \
        --host http://127.0.0.1:18000 --users 150 --spawn-rate 5 --run-time 10m --headless

The users come from tests/load/seed_load.py and act through the demo header X-Demo-User-Id. The
run stops at once unless the target is in demo mode (GET /api/v1/demo/users answers 200), so it
can never load a real installation. Per-domain limits of the product are respected, not raised.

User classes (weights are per spawned user):
  Resident     a resident on the deadline day: dashboard, two readings, history, the forum
  OpenTab      a browser tab left open: the unread count every 60 s, as the client polls it
  Staff        the chairman or accountant: the period matrix (the heaviest read), consumption
  Board        once per run, after a minute: an emergency to everyone (the notification fan-out)
  PhotoReport  only with LOAD_PHOTOS=1: an issue report with a photo (Pillow, memory peaks)
"""

import io
import itertools
import json
import os
import random
import threading
import time
from decimal import Decimal
from pathlib import Path

from locust import HttpUser, between, constant_pacing, events, task
from locust.exception import StopUser

API = "/api/v1"
DATA = json.loads(Path(os.environ.get("LOAD_USERS", "users.json")).read_text())
_lock = threading.Lock()
_residents = itertools.cycle(DATA["residents"])
_staff = itertools.cycle([DATA["chairman"], DATA["accountant"], *DATA["board"]])


def _next(source: itertools.cycle) -> dict | str:
    with _lock:
        return next(source)


@events.test_start.add_listener
def _refuse_a_real_installation(environment, **_kwargs) -> None:
    import requests

    response = requests.get(f"{environment.host}{API}/demo/users", timeout=10)
    if response.status_code != 200:
        environment.runner.quit()
        raise SystemExit(
            f"locustfile: {environment.host} is not in demo mode "
            f"(GET {API}/demo/users answered {response.status_code}); refusing to load it"
        )


class _DemoUser(HttpUser):
    abstract = True
    user_id: str = ""

    def on_start(self) -> None:
        self.client.headers["X-Demo-User-Id"] = self.user_id


class Resident(_DemoUser):
    weight = 10
    wait_time = between(5, 30)  # a person reading the screen, not a bot

    def on_start(self) -> None:
        resident = _next(_residents)
        self.user_id = resident["user_id"]
        self.apartment_id = resident["apartment_id"]
        super().on_start()
        self.pending: list[dict] = []
        self.dashboard()

    @task(5)
    def dashboard(self) -> None:
        with self.client.get(f"{API}/meters/my-dashboard", catch_response=True) as response:
            if response.status_code != 200:
                response.failure(f"{response.status_code}")
                return
            self.pending = [
                meter
                for apartment in response.json()["apartments"]
                for meter in apartment["meters"]
                if meter["next_submission"] and meter["next_submission"]["reading"] is None
            ]

    @task(4)
    def submit_reading(self) -> None:
        if not self.pending:
            return
        meter = self.pending.pop()
        target = meter["next_submission"]
        average = Decimal(target["average_delta"] or "3.000")
        # Close to the usual consumption, so the anomaly confirmation is the exception.
        value = Decimal(target["previous_value"]) + average * Decimal(random.uniform(0.8, 1.2))
        body = {
            "meter_id": meter["meter_id"],
            "period_code": target["period_code"],
            "value": f"{value.quantize(Decimal('0.001'))}",
        }
        with self.client.post(
            f"{API}/meters/readings", json=body, name=f"{API}/meters/readings", catch_response=True
        ) as response:
            if response.status_code == 409 and "ANOMALY" in response.text:
                body["confirmation_level"] = 2  # the resident confirms the unusual value
                body["reason"] = "Load test"
                response.success()
                self.client.post(f"{API}/meters/readings", json=body, name="readings (confirmed)")
            elif response.status_code != 200:
                response.failure(f"{response.status_code} {response.text[:120]}")

    @task(3)
    def history(self) -> None:
        self.client.get(
            f"{API}/meters/apartments/{self.apartment_id}/readings",
            name=f"{API}/meters/apartments/[id]/readings",
        )

    @task(3)
    def forum(self) -> None:
        self.client.get(f"{API}/communication/posts")

    @task(1)
    def emergencies(self) -> None:
        self.client.get(f"{API}/communication/emergencies/active")

    @task(1)
    def notifications(self) -> None:
        self.client.get(f"{API}/notifications/feed")


class OpenTab(_DemoUser):
    """The client polls the unread count every 60 s while the page is visible."""

    weight = 10
    wait_time = constant_pacing(60)

    def on_start(self) -> None:
        self.user_id = _next(_residents)["user_id"]
        super().on_start()

    @task
    def unread_count(self) -> None:
        self.client.get(f"{API}/notifications/unread-count")


class Staff(_DemoUser):
    weight = 1
    wait_time = between(20, 90)

    def on_start(self) -> None:
        self.user_id = _next(_staff)
        super().on_start()

    @task(3)
    def matrix(self) -> None:
        self.client.get(
            f"{API}/meters/periods/{DATA['current_period']}/matrix",
            name=f"{API}/meters/periods/[code]/matrix",
        )

    @task(1)
    def consumption(self) -> None:
        self.client.get(f"{API}/meters/consumption?months=12", name=f"{API}/meters/consumption")


class Board(_DemoUser):
    """One emergency per run, a minute in, so its fan-out lands on a loaded installation."""

    fixed_count = 1
    wait_time = constant_pacing(5)
    _published = False

    def on_start(self) -> None:
        self.user_id = DATA["board"][0]
        super().on_start()
        self.started = time.monotonic()

    @task
    def emergency_once(self) -> None:
        if Board._published or time.monotonic() - self.started < 60:
            return
        Board._published = True
        body = {
            "post_type": "EMERGENCY",
            "title": "Load test: water off in entrance 1",
            "body": "A load test emergency. Nothing is wrong.",
        }
        self.client.post(f"{API}/communication/posts", json=body, name="emergency (fan-out)")
        raise StopUser()


def _photo() -> bytes:
    from PIL import Image

    image = Image.effect_noise((2560, 1920), 64).convert("RGB")  # noise compresses badly
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=85)
    return buffer.getvalue()


class PhotoReport(_DemoUser):
    """An issue report with one photo; only with LOAD_PHOTOS=1 (the upload limit is 1+4 queued)."""

    weight = 1 if os.environ.get("LOAD_PHOTOS") == "1" else 0
    wait_time = between(30, 120)
    photo = b""

    def on_start(self) -> None:
        resident = _next(_residents)
        self.user_id = resident["user_id"]
        self.apartment_id = resident["apartment_id"]
        super().on_start()
        if not PhotoReport.photo:
            PhotoReport.photo = _photo()

    @task
    def report_with_photo(self) -> None:
        body = {
            "category": "LIGHTING",
            "place": "Stairwell",
            "title": "Load test: a lamp is out",
            "apartment_id": self.apartment_id,
        }
        response = self.client.post(f"{API}/issues", json=body)
        if response.status_code != 201:
            return  # 429: the daily limit per apartment, as in real use
        self.client.post(
            f"{API}/issues/{response.json()['id']}/photos",
            data=PhotoReport.photo,
            headers={"Content-Type": "image/jpeg"},
            name=f"{API}/issues/[id]/photos",
        )
