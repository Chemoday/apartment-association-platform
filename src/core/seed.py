"""Demo building "KÜ Sõpruse 12" for local runs and the public demo (docs/TASKS.md, Task 7).

Run by entrypoint.sh after the migrations:  python -m src.core.seed
It only seeds when SEED_DEMO_DATA is true, and only into an EMPTY database (no building yet), so it
never mixes demo residents into a real association. Running it again, or from two containers at
once (an advisory lock serializes them), changes nothing.

Like models_registry.py this is a composition root: it writes the models of several modules
directly, because no module offers "create a building with history" as a service. It publishes no
domain events, so seeding never sends notifications. All ids are fixed (uuid5), so the demo users
are the same on every instance (see DEMO_USERS and GET /api/v1/demo/users).
"""

import asyncio
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from zoneinfo import ZoneInfo

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import settings
from src.core.database import build_engine, transaction
from src.core.telemetry import configure_logging
from src.core.validation import canonical_email
from src.modules.communication.models import Comment, Post
from src.modules.communication.schemas import PostCategory, PostOrigin, PostType, TargetScope
from src.modules.governance.models import (
    Ballot,
    BallotAnswer,
    BallotRevision,
    Poll,
    PollElector,
    PollOption,
    PollQuestion,
)
from src.modules.governance.schemas import (
    AnswerMode,
    Eligibility,
    PollKind,
    PollStatus,
    PollUnit,
    ValueType,
)
from src.modules.issues.models import Issue, IssueFollower, IssueStatusChange
from src.modules.issues.schemas import IssueCategory, IssueStatus
from src.modules.maintenance.messages import local_date, render
from src.modules.maintenance.models import LogEntry, Occurrence, Task
from src.modules.maintenance.policies import add_months
from src.modules.maintenance.schemas import LogKind, OccurrenceStatus, PeriodUnit, TaskStatus
from src.modules.meters.models import MeterDevice, MeterReading, MeterReadingLog, ReadingPeriod
from src.modules.meters.policies import period_due_date
from src.modules.meters.schemas import MeterUnit, PeriodStatus, ReadingSource, ResourceType
from src.modules.property.models import Apartment, ApartmentMembership, Building, User
from src.modules.property.schemas import BuildingRole, DisplayMode, RelationType

logger = structlog.get_logger(__name__)

_NAMESPACE = uuid.UUID("5b0d6f3c-9a3e-4f1e-8d2a-1c7e0b6a4f12")
# pg_advisory_xact_lock key: concurrent seeders wait for each other instead of racing.
SEED_LOCK_KEY = 7_202_610_001
D = Decimal
_PRECISION = D("0.001")


def demo_id(name: str) -> uuid.UUID:
    """The fixed id of a demo entity: the same on every instance and every run."""
    return uuid.uuid5(_NAMESPACE, name)


DEMO_BUILDING_ID = demo_id("building")
DEMO_REGISTRY_CODE = "80123456"
DEMO_ADDRESS = "Sõpruse pst 12, Kristiine, 10615 Tallinn"
# The demo residents moved in long before every demo post, so they see the demo thread (E8/P2).
DEMO_MOVED_IN = datetime(2024, 6, 1, tzinfo=UTC)


# --- The demo building --------------------------------------------------------------------------


@dataclass(frozen=True)
class _ApartmentSpec:
    number: str
    entrance: int
    floor: int
    area_m2: str
    cold_per_month: str  # typical cold water consumption, m3
    initial_cold: str
    initial_hot: str


_APARTMENTS = (
    _ApartmentSpec("1", 1, 1, "48.20", "4.200", "120.000", "60.000"),
    _ApartmentSpec("2", 1, 1, "54.30", "3.100", "95.500", "41.200"),
    _ApartmentSpec("3", 1, 2, "62.10", "5.600", "210.000", "98.300"),
    _ApartmentSpec("13", 2, 3, "48.20", "2.400", "64.000", "30.100"),
    _ApartmentSpec("14", 2, 4, "54.30", "4.800", "124.000", "55.700"),
    _ApartmentSpec("15", 2, 4, "62.10", "6.300", "301.000", "140.400"),
)
_HOT_SHARE = D("0.45")  # hot water is about 45 % of cold
_MASTER_LOSS = {ResourceType.COLD_WATER: D("1.04"), ResourceType.HOT_WATER: D("1.03")}
_MASTER_INITIAL = {ResourceType.COLD_WATER: D("5000.000"), ResourceType.HOT_WATER: D("2000.000")}


class DemoUserKey(StrEnum):
    CHAIRMAN = "chairman"
    BOARD = "board"
    ACCOUNTANT = "accountant"
    OWNER_14 = "owner_14"
    OWNER_1 = "owner_1"
    TENANT_2 = "tenant_2"


@dataclass(frozen=True)
class DemoUser:
    """A seeded user for the demo role switcher. Fictitious people; the label has no name."""

    key: DemoUserKey
    label: str
    building_role: BuildingRole
    full_name: str
    apartment_number: str | None = None
    relation_type: RelationType | None = None
    display_mode: DisplayMode = DisplayMode.APARTMENT_ONLY

    @property
    def user_id(self) -> uuid.UUID:
        return demo_id(f"user:{self.key.value}")

    @property
    def email(self) -> str:
        return canonical_email(f"{self.full_name.replace(' ', '.')}@demo.invalid")


DEMO_USERS: tuple[DemoUser, ...] = (
    DemoUser(DemoUserKey.CHAIRMAN, "Chairman", BuildingRole.CHAIRMAN, "Oleg Sidorov"),
    DemoUser(
        DemoUserKey.BOARD,
        "Board member (Apt 15)",
        BuildingRole.BOARD,
        "Peeter Saar",
        "15",
        RelationType.OWNER,
        DisplayMode.FULL_NAME,
    ),
    DemoUser(DemoUserKey.ACCOUNTANT, "Accountant", BuildingRole.ACCOUNTANT, "Anna Kask"),
    DemoUser(
        DemoUserKey.OWNER_14,
        "Owner Apt 14",
        BuildingRole.USER,
        "Ivan Petrov",
        "14",
        RelationType.OWNER,
    ),
    DemoUser(
        DemoUserKey.OWNER_1,
        "Owner Apt 1",
        BuildingRole.USER,
        "Kati Mets",
        "1",
        RelationType.OWNER,
        DisplayMode.FULL_NAME,
    ),
    DemoUser(
        DemoUserKey.TENANT_2,
        "Tenant Apt 2",
        BuildingRole.USER,
        "Mari Tamm",
        "2",
        RelationType.TENANT,
        DisplayMode.INITIALS,
    ),
)

HISTORY_PERIODS = ("2026-07", "2026-08", "2026-09")
OPEN_PERIOD = "2026-10"
_MONTH_FACTOR = {"2026-07": D("0.95"), "2026-08": D("1.00"), "2026-09": D("1.05")}


def _q(value: Decimal) -> Decimal:
    return value.quantize(_PRECISION, rounding=ROUND_HALF_UP)


def _due_date(period_code: str, deadline_day: int) -> datetime:
    return period_due_date(period_code, deadline_day, settings.INSTANCE_TIMEZONE)


_INSERT_ORDER = (
    Building,
    Apartment,
    User,
    ApartmentMembership,
    MeterDevice,
    ReadingPeriod,
    MeterReading,
    MeterReadingLog,
    Post,
    Comment,
    Poll,
    PollQuestion,
    PollOption,
    PollElector,
    Ballot,
    BallotAnswer,
    BallotRevision,
    Issue,
    IssueFollower,
    IssueStatusChange,
    Task,
    Occurrence,
    LogEntry,
)


class _Builder:
    """Collects the rows of the demo building; all of them are added in one transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.rows: list[object] = []
        self.users: dict[DemoUserKey, User] = {}
        self.apartments: dict[str, Apartment] = {}
        self.periods: dict[str, ReadingPeriod] = {}
        self.last_value: dict[uuid.UUID, Decimal] = {}

    def add(self, *rows: object) -> None:
        self.rows.extend(rows)

    async def insert(self) -> None:
        """Insert table by table, parents first. Models of different modules have no ORM
        relationship(), so the unit of work cannot know that a comment needs its post first."""
        for model in _INSERT_ORDER:
            self.session.add_all(row for row in self.rows if type(row) is model)
            await self.session.flush()
        leftover = {type(row).__name__ for row in self.rows} - {m.__name__ for m in _INSERT_ORDER}
        if leftover:
            raise RuntimeError(f"seed rows without an insert order: {sorted(leftover)}")

    # --- property ---

    def building(self) -> Building:
        building = Building(
            id=DEMO_BUILDING_ID,
            name="KÜ Sõpruse 12",
            registry_code=DEMO_REGISTRY_CODE,
            address=DEMO_ADDRESS,
            country_code="EE",
            reading_deadline_day=4,
        )
        self.add(building)
        for spec in _APARTMENTS:
            apartment = Apartment(
                id=demo_id(f"apartment:{spec.number}"),
                building_id=building.id,
                number=spec.number,
                entrance=spec.entrance,
                floor=spec.floor,
                area_m2=D(spec.area_m2),
            )
            self.apartments[spec.number] = apartment
            self.add(apartment)
        for index, demo in enumerate(DEMO_USERS, start=1):
            user = User(
                id=demo.user_id,
                building_id=building.id,
                full_name=demo.full_name,
                email=demo.email,
                phone=f"+372 5000 {index:04d}",
                building_role=demo.building_role,
            )
            self.users[demo.key] = user
            self.add(user)
            if demo.apartment_number is not None:
                is_owner = demo.relation_type == RelationType.OWNER
                self.add(
                    ApartmentMembership(
                        id=demo_id(f"membership:{demo.key.value}"),
                        apartment_id=self.apartments[demo.apartment_number].id,
                        user_id=user.id,
                        relation_type=demo.relation_type,
                        can_submit_readings=True,
                        can_view_bills=is_owner,
                        can_vote=is_owner,
                        privacy_display_mode=demo.display_mode,
                        started_at=DEMO_MOVED_IN,
                    )
                )
        return building

    # --- meters ---

    def meters(self, building: Building) -> tuple[list[tuple[MeterDevice, Decimal]], list]:
        """Apartment meters with their monthly consumption, and the master meters."""
        apartment_meters: list[tuple[MeterDevice, Decimal]] = []
        for spec in _APARTMENTS:
            cold = D(spec.cold_per_month)
            for resource, initial, monthly, limit in (
                (ResourceType.COLD_WATER, spec.initial_cold, cold, "25.000"),
                (ResourceType.HOT_WATER, spec.initial_hot, _q(cold * _HOT_SHARE), "15.000"),
            ):
                meter = MeterDevice(
                    id=demo_id(f"meter:{spec.number}:{resource.value}"),
                    building_id=building.id,
                    apartment_id=self.apartments[spec.number].id,
                    resource_type=resource,
                    serial_number=f"SN-{spec.number}-{resource.value[:1]}W",
                    location_label="Bathroom",
                    unit=MeterUnit.M3,
                    initial_value=D(initial),
                    max_monthly_delta=D(limit),
                )
                self.last_value[meter.id] = meter.initial_value
                apartment_meters.append((meter, monthly))
                self.add(meter)
        masters = []
        for resource in (ResourceType.COLD_WATER, ResourceType.HOT_WATER):
            master = MeterDevice(
                id=demo_id(f"meter:master:{resource.value}"),
                building_id=building.id,
                apartment_id=None,
                resource_type=resource,
                serial_number=f"SN-MASTER-{resource.value[:1]}W",
                location_label="Basement Master",
                unit=MeterUnit.M3,
                initial_value=_MASTER_INITIAL[resource],
                max_monthly_delta=D("500.000"),
            )
            self.last_value[master.id] = master.initial_value
            masters.append(master)
            self.add(master)
        return apartment_meters, masters

    def period(self, building: Building, code: str, status: PeriodStatus) -> ReadingPeriod:
        period = ReadingPeriod(
            id=demo_id(f"period:{code}"),
            building_id=building.id,
            period_code=code,
            status=status,
            due_date=_due_date(code, building.reading_deadline_day),
        )
        self.periods[code] = period
        self.add(period)
        return period

    def reading(
        self,
        meter: MeterDevice,
        period: ReadingPeriod,
        delta: Decimal,
        source: ReadingSource,
        actor: User | None,
        *,
        anomaly: bool = False,
        typo: Decimal | None = None,
    ) -> MeterReading:
        """A reading plus its audit trail. `typo`: first submitted value, corrected afterwards."""
        previous = self.last_value[meter.id]
        value = previous + delta
        at = period.due_date - timedelta(days=3)
        reading = MeterReading(
            id=demo_id(f"reading:{meter.id}:{period.period_code}"),
            building_id=meter.building_id,
            meter_id=meter.id,
            period_id=period.id,
            value=value,
            previous_value=previous,
            consumption_delta=delta,
            source=source,
            is_anomaly_confirmed=anomaly,
            submitted_by_user_id=actor.id if source != ReadingSource.AUTO_ESTIMATED else None,
            recorded_at=at,
        )
        self.add(reading)
        logged_by = actor or self.users[DemoUserKey.CHAIRMAN]
        first_reason = {
            ReadingSource.RESIDENT: "Resident submission",
            ReadingSource.ADMIN_OVERRIDE: "Board entry",
            ReadingSource.AUTO_ESTIMATED: "3-month avg estimate",
        }[source]
        entries = [(None, typo if typo is not None else value, first_reason)]
        if typo is not None:
            entries.append((typo, value, "Resident update"))
        for step, (old, new, reason) in enumerate(entries):
            self.add(
                MeterReadingLog(
                    id=demo_id(f"log:{reading.id}:{step}"),
                    reading_id=reading.id,
                    old_value=old,
                    new_value=new,
                    source=source,
                    changed_by_user_id=logged_by.id,
                    reason=reason,
                    changed_at=at + timedelta(hours=step * 5),
                )
            )
        self.last_value[meter.id] = value
        return reading

    # --- communication ---

    def posts(self, building: Building, now: datetime) -> None:
        users, apartments = self.users, self.apartments
        alert = Post(
            id=demo_id("post:emergency"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.CHAIRMAN].id,
            post_type=PostType.EMERGENCY,
            category=PostCategory.WATER_SHUTOFF,
            title="Hot water off in entrance 2 on Monday, 09:00-15:00",
            body="The hot water riser in entrance 2 is being replaced. Please store some water "
            "in advance. Entrance 1 is not affected.",
            target_scope=TargetScope.ENTRANCE,
            target_entrance=2,
            created_at=now - timedelta(hours=2),
        )
        notice = Post(
            id=demo_id("post:notice"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.CHAIRMAN].id,
            post_type=PostType.OFFICIAL_NOTICE,
            category=PostCategory.GENERAL,
            title="October meter readings are due by 4 November",
            body="Please submit your cold and hot water readings in the app. Missing readings "
            "are estimated from your 3-month average.",
            comments_enabled=False,
            created_at=now - timedelta(days=3),
        )
        bikes = Post(
            id=demo_id("post:bike-rack"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.OWNER_14].id,
            author_apartment_id=apartments["14"].id,
            post_type=PostType.FORUM_TOPIC,
            category=PostCategory.GENERAL,
            title="Shall we put a bike rack in the yard?",
            body="Bikes block the stairwell every evening. A rack near entrance 2 would fit "
            "about ten bikes. What do you think?",
            created_at=now - timedelta(days=2),
        )
        give_away = Post(
            id=demo_id("post:give-away"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.OWNER_1].id,
            author_apartment_id=apartments["1"].id,
            post_type=PostType.FORUM_TOPIC,
            category=PostCategory.MARKETPLACE,
            title="Giving away a children's bike",
            body="16-inch wheels, good condition. Free to a neighbour, pick it up in entrance 1.",
            created_at=now - timedelta(days=1),
        )
        # A board <-> apartment thread (E8/P2): the chairman writes as the board, the owner of
        # apartment 14 answers from the apartment.
        thread = Post(
            id=demo_id("post:thread-14"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.CHAIRMAN].id,
            post_type=PostType.APARTMENT_THREAD,
            category=PostCategory.GENERAL,
            title="Access to the cold water meter in apartment 14",
            body="Hello! The September cold water reading was corrected after submission. Could "
            "you double-check the meter when you submit the October reading?",
            target_scope=TargetScope.APARTMENT_LIST,
            target_apartment_ids=[str(apartments["14"].id)],
            created_at=now - timedelta(hours=30),
        )
        # The board's micro-forum (E8/P4): only the chairman and the board see it, by name.
        keys = Post(
            id=demo_id("post:board-keys"),
            building_id=building.id,
            author_user_id=users[DemoUserKey.CHAIRMAN].id,
            post_type=PostType.BOARD_TOPIC,
            category=PostCategory.GENERAL,
            title="Where the keys to the basement and the roof are",
            body="The basement key is in the board's box in entrance 1; the roof key is with the "
            "chairman. Please write here when you take one.",
            created_at=now - timedelta(days=4),
        )
        self.add(alert, notice, bikes, give_away, thread, keys)
        comments = (
            (bikes, DemoUserKey.TENANT_2, "2", "Yes, please. I carry my bike up to the 1st floor."),
            (bikes, DemoUserKey.BOARD, "15", "The board can put it on the next meeting's agenda."),
            (bikes, DemoUserKey.OWNER_1, "1", "Good idea, but please leave room for prams."),
            (give_away, DemoUserKey.OWNER_14, "14", "My son would love it. Is it still free?"),
            (thread, DemoUserKey.OWNER_14, "14", "Sure, I will check it tonight."),
            (keys, DemoUserKey.BOARD, None, "Took the basement key on Monday, back on Tuesday."),
        )
        for step, (post, author, number, body) in enumerate(comments):
            created_at = post.created_at + timedelta(hours=step + 1)
            self.add(
                Comment(
                    id=demo_id(f"comment:{step}"),
                    post_id=post.id,
                    building_id=building.id,
                    author_user_id=users[author].id,
                    author_apartment_id=apartments[number].id if number else None,
                    body=body,
                    created_at=created_at,
                )
            )
            post.last_activity_at = max(post.last_activity_at or post.created_at, created_at)

    # --- governance ---

    def poll(self, building: Building, now: datetime) -> None:
        """An open informative poll (E3): which Saturday for the spring clean-up, answered by
        apartment 1. Every apartment with demo users is in the electorate."""
        users, apartments = self.users, self.apartments
        saturdays = [
            (now + timedelta(days=offset)).date()
            for offset in range(1, 30)
            if (now + timedelta(days=offset)).weekday() == 5
        ][:2]
        poll = Poll(
            id=demo_id("poll:clean-up"),
            building_id=building.id,
            created_by_user_id=users[DemoUserKey.CHAIRMAN].id,
            kind=PollKind.INFORMATIVE,
            title="Spring clean-up in the yard",
            description="We rake the yard and wash the stairwells together. Which Saturday?",
            target_scope=TargetScope.ALL_BUILDING,
            eligibility=Eligibility.RESIDENTS,
            unit=PollUnit.APARTMENT,
            status=PollStatus.OPEN,
            closes_at=now + timedelta(days=14),
            opened_at=now - timedelta(days=1),
            created_at=now - timedelta(days=1, hours=1),
            updated_at=now - timedelta(days=1),
        )
        day = PollQuestion(
            id=demo_id("poll:clean-up:day"),
            poll_id=poll.id,
            building_id=building.id,
            position=1,
            text="Which Saturday suits you?",
            answer_mode=AnswerMode.MULTIPLE_CHOICE,
            value_type=ValueType.DATE,
            required=True,
            min_choices=1,
            max_choices=2,
        )
        note = PollQuestion(
            id=demo_id("poll:clean-up:note"),
            poll_id=poll.id,
            building_id=building.id,
            position=2,
            text="Anything the board should know?",
            answer_mode=AnswerMode.OWN_VALUE,
            value_type=ValueType.TEXT,
            required=False,
        )
        options = [
            PollOption(
                id=demo_id(f"poll:clean-up:day:{index}"),
                question_id=day.id,
                poll_id=poll.id,
                position=index,
                value=saturday.isoformat(),
            )
            for index, saturday in enumerate(saturdays, start=1)
        ]
        lived_in = sorted(
            {demo.apartment_number for demo in DEMO_USERS if demo.apartment_number}, key=str
        )
        electors = {
            number: PollElector(
                id=demo_id(f"poll:clean-up:elector:{number}"),
                poll_id=poll.id,
                building_id=building.id,
                apartment_id=apartments[number].id,
            )
            for number in lived_in
        }
        ballot = Ballot(
            id=demo_id("poll:clean-up:ballot:1"),
            poll_id=poll.id,
            elector_id=electors["1"].id,
            cast_by_user_id=users[DemoUserKey.OWNER_1].id,
            revision=1,
            created_at=now - timedelta(hours=20),
            updated_at=now - timedelta(hours=20),
        )
        answer = BallotAnswer(
            id=demo_id("poll:clean-up:ballot:1:answer"),
            ballot_id=ballot.id,
            poll_id=poll.id,
            question_id=day.id,
            option_id=options[0].id,
        )
        revision = BallotRevision(
            id=demo_id("poll:clean-up:ballot:1:revision"),
            ballot_id=ballot.id,
            revision=1,
            cast_by_user_id=ballot.cast_by_user_id,
            answers=[
                {"question_id": str(day.id), "option_ids": [str(options[0].id)], "value": None}
            ],
            created_at=ballot.created_at,
        )
        self.add(poll, day, note, *options, *electors.values(), ballot, answer, revision)

    # --- maintenance ---

    def maintenance(self, building: Building, now: datetime) -> None:
        """Three maintenance tasks (E10): the extinguishers next spring, the gutters soon with a
        notice for residents, and the heating substation 10 days overdue, already published with
        one reminder. Two log entries with costs."""
        chairman = self.users[DemoUserKey.CHAIRMAN]
        today = now.astimezone(ZoneInfo(settings.INSTANCE_TIMEZONE)).date()
        april = date(today.year + (1 if (today.month, today.day) >= (4, 1) else 0), 4, 15)

        def task(
            key: str,
            title: str,
            unit: PeriodUnit,
            count: int,
            lead: int,
            anchor: date,
            instructions: str,
            day: int | None = None,
            **notice: object,
        ) -> Task:
            return Task(
                id=demo_id(f"maintenance:{key}"),
                building_id=building.id,
                title=title,
                instructions=instructions,
                period_unit=unit,
                period_count=count,
                lead_days=lead,
                anchor_date=anchor,
                anchor_day=day or anchor.day,
                status=TaskStatus.ACTIVE,
                created_by_user_id=chairman.id,
                updated_by_user_id=chairman.id,
                created_at=now - timedelta(days=200),
                updated_at=now - timedelta(days=200),
                **notice,
            )

        extinguishers = task(
            "extinguishers",
            "Inspect the fire extinguishers",
            PeriodUnit.MONTH,
            12,
            14,
            april,
            "Basement and every landing. The service company has the keys list.",
        )
        gutters_due = today + timedelta(days=20)
        gutters = task(
            "gutters",
            "Clean the gutters",
            PeriodUnit.MONTH,
            6,
            14,
            add_months(gutters_due, -6),
            "Book the lift truck a week ahead.",
            day=gutters_due.day,
            notice_title="Gutters are cleaned",
            notice_body="A lift truck works in the yard. Please move cars from the yard by 08:00.",
            notice_category=PostCategory.MAINTENANCE.value,
            notice_target_scope=TargetScope.ALL_BUILDING.value,
            notice_comments_enabled=False,
        )
        heating_due = today - timedelta(days=10)
        heating = task(
            "heating",
            "Check the heating substation",
            PeriodUnit.DAY,
            30,
            5,
            heating_due - timedelta(days=30),
            "Pressure and filters; write the readings down.",
        )

        def occurrence(key: str, owner: Task, seq: int, due: date, closed: bool) -> Occurrence:
            return Occurrence(
                id=demo_id(f"maintenance:{key}"),
                task_id=owner.id,
                building_id=building.id,
                seq=seq,
                due_date=due,
                status=OccurrenceStatus.DONE if closed else OccurrenceStatus.OPEN,
                closed_at=now - timedelta(days=40) if closed else None,
            )

        gutters_done = occurrence("gutters:0", gutters, 0, gutters.anchor_date, True)
        heating_done = occurrence("heating:0", heating, 0, heating.anchor_date, True)
        heating_open = occurrence("heating:1", heating, 1, heating_due, False)
        published_at = now - timedelta(days=15)
        locale = settings.DEFAULT_LOCALE
        due_text = local_date(heating_due)
        topic = Post(
            id=demo_id("maintenance:heating:topic"),
            building_id=building.id,
            author_user_id=chairman.id,
            post_type=PostType.BOARD_TOPIC,
            category=PostCategory.MAINTENANCE,
            title=render("board.title.DUE", locale, title=heating.title, date=due_text),
            body=f"{heating.instructions}\n\n{render('board.footer', locale)}",
            origin=PostOrigin.MAINTENANCE,
            created_at=published_at,
        )
        reminder = Comment(
            id=demo_id("maintenance:heating:reminder:1"),
            post_id=topic.id,
            building_id=building.id,
            author_user_id=chairman.id,
            body=render("comment.overdue", locale, date=due_text, number=1),
            created_at=now - timedelta(days=9),
        )
        topic.last_activity_at = reminder.created_at
        heating_open.published_at, heating_open.board_post_id = published_at, topic.id
        heating_open.last_reminded_on, heating_open.reminder_count = today - timedelta(days=9), 1
        heating_open.next_remind_on = today - timedelta(days=2)

        def entry(key: str, done: Occurrence, owner: Task, cost: str, note: str) -> LogEntry:
            return LogEntry(
                id=demo_id(f"maintenance:log:{key}"),
                building_id=building.id,
                task_id=owner.id,
                occurrence_id=done.id,
                kind=LogKind.DONE,
                closed_on=done.due_date + timedelta(days=2),
                note=note,
                cost=Decimal(cost),
                recorded_by_user_id=chairman.id,
                created_at=now - timedelta(days=40),
                updated_at=now - timedelta(days=40),
            )

        self.add(
            extinguishers,
            gutters,
            heating,
            occurrence("extinguishers:0", extinguishers, 0, april, False),
            gutters_done,
            occurrence("gutters:1", gutters, 1, gutters_due, False),
            heating_done,
            heating_open,
            topic,
            reminder,
            entry("gutters", gutters_done, gutters, "80.50", "Both sides, one downpipe cleared."),
            entry("heating", heating_done, heating, "145.00", "Filters changed."),
        )

    # --- issues ---

    def issues(self, building: Building, now: datetime) -> None:
        """Two issues (E9): an open one reported by apartment 14 with a "+1" from apartment 2,
        and one that apartment 2 withdrew (seen only by its reporter and the board)."""
        users, apartments = self.users, self.apartments
        owner_14, tenant_2 = users[DemoUserKey.OWNER_14], users[DemoUserKey.TENANT_2]
        light_at, door_at = now - timedelta(days=2), now - timedelta(days=1)
        light = Issue(
            id=demo_id("issue:stair-light"),
            building_id=building.id,
            reporter_user_id=owner_14.id,
            reporter_apartment_id=apartments["14"].id,
            category=IssueCategory.LIGHTING,
            entrance=2,
            place="3rd floor landing",
            title="No light on the 3rd floor landing",
            description="The lamp flickered for a week and went out yesterday evening.",
            status=IssueStatus.REPORTED,
            created_at=light_at,
            updated_at=light_at,
        )
        door = Issue(
            id=demo_id("issue:door-closer"),
            building_id=building.id,
            reporter_user_id=tenant_2.id,
            reporter_apartment_id=apartments["2"].id,
            category=IssueCategory.DOORS_AND_LOCKS,
            entrance=1,
            place="Front door",
            title="The front door slams",
            status=IssueStatus.WITHDRAWN,
            created_at=door_at,
            updated_at=door_at + timedelta(hours=2),
            ended_at=door_at + timedelta(hours=2),
        )
        self.add(
            light,
            door,
            IssueFollower(issue_id=light.id, user_id=owner_14.id, created_at=light_at),
            IssueFollower(
                issue_id=light.id, user_id=tenant_2.id, created_at=light_at + timedelta(hours=5)
            ),
            IssueFollower(issue_id=door.id, user_id=tenant_2.id, created_at=door_at),
            IssueStatusChange(
                id=demo_id("issue:stair-light:reported"),
                issue_id=light.id,
                to_status=IssueStatus.REPORTED,
                changed_by_user_id=owner_14.id,
                changed_at=light_at,
            ),
            IssueStatusChange(
                id=demo_id("issue:door-closer:reported"),
                issue_id=door.id,
                to_status=IssueStatus.REPORTED,
                changed_by_user_id=tenant_2.id,
                changed_at=door_at,
            ),
            IssueStatusChange(
                id=demo_id("issue:door-closer:withdrawn"),
                issue_id=door.id,
                from_status=IssueStatus.REPORTED,
                to_status=IssueStatus.WITHDRAWN,
                changed_by_user_id=tenant_2.id,
                changed_at=door_at + timedelta(hours=2),
            ),
        )


async def seed_demo_data(session: AsyncSession, now: datetime | None = None) -> bool:
    """Add the demo building to an empty database. Returns False when nothing was done.

    The caller commits (use `transaction(session)`).
    """
    await session.execute(select(func.pg_advisory_xact_lock(SEED_LOCK_KEY)))
    if await session.scalar(select(Building.id).limit(1)) is not None:
        demo = await session.get(Building, DEMO_BUILDING_ID)
        if demo is not None and demo.registry_code is None:
            # Seeded before the registry code existed (migration 004): complete the demo building.
            demo.registry_code, demo.address = DEMO_REGISTRY_CODE, DEMO_ADDRESS
            logger.info("seed_demo_building_completed")
        logger.info("seed_skipped", reason="already_seeded" if demo else "not_empty")
        return False

    now = now or datetime.now(UTC)
    builder = _Builder(session)
    building = builder.building()
    apartment_meters, masters = builder.meters(building)
    users = builder.users
    resident_of = {
        demo.apartment_number: users[demo.key] for demo in DEMO_USERS if demo.apartment_number
    }
    chairman, accountant = users[DemoUserKey.CHAIRMAN], users[DemoUserKey.ACCOUNTANT]

    for code in HISTORY_PERIODS:
        period = builder.period(building, code, PeriodStatus.LOCKED)
        totals = dict.fromkeys(_MASTER_LOSS, D("0"))
        for meter, monthly in apartment_meters:
            delta = _q(monthly * _MONTH_FACTOR[code])
            number = next(n for n, a in builder.apartments.items() if a.id == meter.apartment_id)
            resident = resident_of.get(number)
            typo = None
            cold = meter.resource_type == ResourceType.COLD_WATER
            if number == "14" and code == "2026-09" and cold:
                typo = builder.last_value[meter.id] + delta + D("10.000")  # fixed a day later
            if resident is not None:
                builder.reading(meter, period, delta, ReadingSource.RESIDENT, resident, typo=typo)
            elif number == "13" and code == "2026-08":
                # Nobody submitted: the board estimated it from the only earlier month (July).
                delta = _q(monthly * _MONTH_FACTOR["2026-07"])
                builder.reading(meter, period, delta, ReadingSource.AUTO_ESTIMATED, None)
            else:  # paper forms, typed in by the chairman
                builder.reading(meter, period, delta, ReadingSource.ADMIN_OVERRIDE, chairman)
            totals[meter.resource_type] += delta
        for master in masters:
            delta = _q(totals[master.resource_type] * _MASTER_LOSS[master.resource_type])
            builder.reading(master, period, delta, ReadingSource.ADMIN_OVERRIDE, accountant)

    # October is open: some residents already submitted, Apt 14 is left for the demo.
    october = builder.period(building, OPEN_PERIOD, PeriodStatus.OPEN_FOR_RESIDENTS)
    for meter, monthly in apartment_meters:
        number = next(n for n, a in builder.apartments.items() if a.id == meter.apartment_id)
        hot = meter.resource_type == ResourceType.HOT_WATER
        if number == "1" or (number == "2" and not hot):
            builder.reading(meter, october, monthly, ReadingSource.RESIDENT, resident_of[number])
        elif number == "15":
            # A leaking hot water tap: confirmed through both anomaly popups.
            delta = D("31.000") if hot else monthly
            builder.reading(
                meter, october, delta, ReadingSource.RESIDENT, resident_of[number], anomaly=hot
            )

    builder.posts(building, now)
    builder.poll(building, now)
    builder.issues(building, now)
    builder.maintenance(building, now)
    await builder.insert()
    logger.info(
        "seed_completed",
        apartments=len(builder.apartments),
        users=len(users),
        periods=len(builder.periods),
    )
    return True


async def run_seed(database_url: str) -> bool:
    engine = build_engine(database_url)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            async with transaction(session):
                return await seed_demo_data(session)
    finally:
        await engine.dispose()


def main() -> None:
    configure_logging(level=settings.LOG_LEVEL, json_logs=settings.LOG_JSON)
    if not settings.SEED_DEMO_DATA:
        logger.info("seed_skipped", reason="disabled")
        return
    asyncio.run(run_seed(settings.DATABASE_URL))


if __name__ == "__main__":
    main()
