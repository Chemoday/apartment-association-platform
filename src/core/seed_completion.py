"""The completion of the demo building: what was added to the demo after it was first seeded.

Epic E14, task K6 (docs/epics/E14_OBJECT_KINDS.md section 6.1, docs/API.md section 5). The demo
seed (src/core/seed.py) runs only into an empty database, and every environment runs in demo
mode, so the parking spaces, the garage and their people and posts come in here, on every start:
after a fresh seed and into a demo building seeded before them.

It adds what is missing and never duplicates. In the public demo anyone can act as the chairman,
so the demo may have been changed in any way; by construction the completion copes with that and
never stops the start-up:
- it runs in a savepoint: any error is logged as `seed_demo_completion_failed` (the type only, no
  personal data), the savepoint is rolled back and the start-up continues;
- every row goes in with `ON CONFLICT DO NOTHING` without a target, so a row that exists, a taken
  e-mail, an existing membership or object number all mean "leave it", and a dependent row goes
  in only after its parent is checked by id;
- a step whose demo user is inactive (or missing, when the e-mail was taken) is skipped, and an
  existing poll's electorate is never changed (it was fixed when the poll opened).
The caller has already checked that this is not a real installation (src/core/instance/).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

import structlog
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.seed import (
    DEMO_BUILDING_ID,
    DEMO_MOVED_IN,
    DEMO_USERS,
    HISTORY_PERIODS,
    DemoObject,
    DemoUserKey,
    demo_id,
    demo_object_id,
)
from src.modules.communication.models import Comment, Post
from src.modules.communication.schemas import PostCategory, PostType, TargetScope
from src.modules.governance.models import Poll, PollElector, PollOption, PollQuestion
from src.modules.governance.schemas import (
    AnswerMode,
    Eligibility,
    PollKind,
    PollStatus,
    PollUnit,
    ValueType,
)
from src.modules.meters.models import MeterDevice, MeterReading, MeterReadingLog, ReadingPeriod
from src.modules.meters.schemas import MeterUnit, PreviousOrigin, ReadingSource, ResourceType
from src.modules.property.models import Apartment, ApartmentMembership, User
from src.modules.property.schemas import ObjectKind, ObjectRef, RelationType

logger = structlog.get_logger(__name__)

USERS = {demo.key: demo for demo in DEMO_USERS}


@dataclass(frozen=True)
class _ObjectSpec:
    kind: ObjectKind
    number: str
    floor: int | None
    area_m2: str | None

    @property
    def ref(self) -> ObjectRef:
        return ObjectRef(self.kind, self.number)


# Parking space 1 has the number of Apt. 1 on purpose; P-2 is a number with the prefix.
_OBJECTS = (
    _ObjectSpec(ObjectKind.PARKING, "1", None, None),
    _ObjectSpec(ObjectKind.PARKING, "P-2", -1, None),
    _ObjectSpec(ObjectKind.GARAGE, "12", None, "18.50"),
)
P1, P2, G12 = (spec.ref for spec in _OBJECTS)

# The garage's electricity meter. The limit is the building template's (1000 kWh a month): the
# default of 25 would mark every reading an anomaly.
GARAGE_METER_ID = demo_id("meter:GARAGE:12:ELECTRICITY")
_GARAGE_INITIAL = Decimal("1520.000")
_GARAGE_MONTHLY = {
    "2026-07": Decimal("38.000"),
    "2026-08": Decimal("41.500"),
    "2026-09": Decimal("44.000"),
}

NOTICE_GARAGES_ID = demo_id("post:garage-gate-code")
NOTICE_EVERYTHING_ID = demo_id("post:yard-asphalt")
EMERGENCY_PARKING_ID = demo_id("post:parking-gate-stuck")
TOPIC_KINDS_ID = demo_id("post:parking-and-garage-topic")
# Comments on the topic: (id, author, the object signed, body), one hour apart.
_TOPIC_COMMENTS = (
    (
        demo_id("comment:parking-and-garage-topic:0"),
        DemoUserKey.OWNER_14,
        P1,
        "Count me in for parking space 1, if the cable can reach it.",
    ),
    (
        demo_id("comment:parking-and-garage-topic:1"),
        DemoUserKey.OWNER_G12,
        G12,
        "Yes for garage 12. A common offer would be cheaper for everyone.",
    ),
)
COMMENT_KINDS_ID = _TOPIC_COMMENTS[0][0]
POLL_PARKING_ID = demo_id("poll:parking-lines")


def membership_id(key: DemoUserKey, obj: DemoObject) -> uuid.UUID:
    return demo_id(f"membership:{key.value}:{obj.kind.value}:{obj.number}")


def _object_of(key: DemoUserKey, ref: ObjectRef) -> DemoObject:
    for obj in USERS[key].later_objects:
        if obj.ref == ref:
            return obj
    raise ValueError(f"the demo user {key.value} holds no {ref.kind.value} {ref.number}")


class _Completion:
    def __init__(self, session: AsyncSession, now: datetime) -> None:
        self.session = session
        self.now = now
        self.step = "start"  # the step that runs, for the log of a failure

    async def put(self, row: object) -> bool:
        """Insert the row unless any unique key of it exists. True when it went in now.

        The row is a transient ORM object, for the names and types of its columns; the models
        the seed writes have no relationship() (src/core/seed.py), so its attributes are columns."""
        values = {k: v for k, v in vars(row).items() if not k.startswith("_")}
        result = await self.session.execute(
            insert(type(row)).values(**values).on_conflict_do_nothing()
        )
        return result.rowcount == 1

    async def exists(self, model: type, row_id: uuid.UUID) -> bool:
        return await self.session.scalar(select(model.id).where(model.id == row_id)) is not None

    async def active(self, key: DemoUserKey) -> bool:
        """The demo user exists in the demo building and its account is open."""
        return bool(
            await self.session.scalar(
                select(User.is_active).where(
                    User.id == USERS[key].user_id, User.building_id == DEMO_BUILDING_ID
                )
            )
        )

    async def holds(self, key: DemoUserKey, ref: ObjectRef) -> bool:
        """The demo user is active and still holds the demo membership of the object."""
        if not await self.active(key):
            return False
        ended = await self.session.execute(
            select(ApartmentMembership.ended_at).where(
                ApartmentMembership.id == membership_id(key, _object_of(key, ref))
            )
        )
        row = ended.first()
        return row is not None and row.ended_at is None

    async def run(self) -> None:
        for step in (self.objects, self.people, self.garage_meter, self.posts, self.poll):
            self.step = step.__name__
            await step()

    async def objects(self) -> None:
        for spec in _OBJECTS:
            await self.put(
                Apartment(
                    id=demo_object_id(spec.ref),
                    building_id=DEMO_BUILDING_ID,
                    kind=spec.kind,
                    number=spec.number,
                    entrance=None,
                    floor=spec.floor,
                    area_m2=Decimal(spec.area_m2) if spec.area_m2 else None,
                )
            )

    async def people(self) -> None:
        for demo in DEMO_USERS:
            if demo.added_later:
                await self.put(
                    User(
                        id=demo.user_id,
                        building_id=DEMO_BUILDING_ID,
                        full_name=demo.full_name,
                        email=demo.email,
                        phone=demo.phone,
                        building_role=demo.building_role,
                    )
                )
            if not demo.later_objects or not await self.active(demo.key):
                continue
            for obj in demo.later_objects:
                if not await self.exists(Apartment, obj.apartment_id):
                    continue
                is_owner = obj.relation == RelationType.OWNER
                await self.put(
                    ApartmentMembership(
                        id=membership_id(demo.key, obj),
                        apartment_id=obj.apartment_id,
                        user_id=demo.user_id,
                        relation_type=obj.relation,
                        can_submit_readings=True,
                        can_view_bills=is_owner,
                        can_vote=is_owner,
                        privacy_display_mode=obj.display_mode,
                        started_at=DEMO_MOVED_IN,
                    )
                )

    async def garage_meter(self) -> None:
        """G12's meter with readings in the locked months: the matrix lists every active meter in
        every month and would show G12 as missing everywhere. Its owner submitted them; without
        the owner (an e-mail taken, a closed account) the chairman typed them in from paper, as
        for the apartments without app users."""
        if not await self.exists(Apartment, demo_object_id(G12)):
            return
        await self.put(
            MeterDevice(
                id=GARAGE_METER_ID,
                building_id=DEMO_BUILDING_ID,
                apartment_id=demo_object_id(G12),
                resource_type=ResourceType.ELECTRICITY,
                serial_number="SN-G12-EL",
                location_label="Garage",
                unit=MeterUnit.KWH,
                initial_value=_GARAGE_INITIAL,
                max_monthly_delta=Decimal("1000.000"),
            )
        )
        if not await self.exists(MeterDevice, GARAGE_METER_ID):
            return
        if await self.holds(DemoUserKey.OWNER_G12, G12):
            actor, source, reason = (
                DemoUserKey.OWNER_G12,
                ReadingSource.RESIDENT,
                "Resident submission",
            )
        elif await self.active(DemoUserKey.CHAIRMAN):
            actor, source, reason = (
                DemoUserKey.CHAIRMAN,
                ReadingSource.ADMIN_OVERRIDE,
                "Board entry",
            )
        else:
            return
        actor_id = USERS[actor].user_id
        previous = _GARAGE_INITIAL
        for step, code in enumerate(HISTORY_PERIODS):
            period_id = demo_id(f"period:{code}")
            delta = _GARAGE_MONTHLY[code]
            value = previous + delta
            due = await self.session.scalar(
                select(ReadingPeriod.due_date).where(ReadingPeriod.id == period_id)
            )
            if due is None:
                return  # the chain of readings needs every month
            reading_id = demo_id(f"reading:{GARAGE_METER_ID}:{code}")
            at = due - timedelta(days=3)
            await self.put(
                MeterReading(
                    id=reading_id,
                    building_id=DEMO_BUILDING_ID,
                    meter_id=GARAGE_METER_ID,
                    period_id=period_id,
                    value=value,
                    previous_value=previous,
                    previous_origin=PreviousOrigin.HISTORY if step else PreviousOrigin.INITIAL,
                    consumption_delta=delta,
                    source=source,
                    is_anomaly_confirmed=False,
                    submitted_by_user_id=actor_id,
                    recorded_at=at,
                )
            )
            if await self.exists(MeterReading, reading_id):
                await self.put(
                    MeterReadingLog(
                        id=demo_id(f"log:{reading_id}:0"),
                        reading_id=reading_id,
                        old_value=None,
                        new_value=value,
                        source=source,
                        changed_by_user_id=actor_id,
                        reason=reason,
                        changed_at=at,
                    )
                )
            previous = value

    def post(self, post_id: uuid.UUID, author: DemoUserKey, **fields: object) -> Post:
        return Post(
            id=post_id,
            building_id=DEMO_BUILDING_ID,
            author_user_id=USERS[author].user_id,
            category=fields.pop("category", PostCategory.GENERAL),
            **fields,
        )

    async def posts(self) -> None:
        now = self.now
        if await self.active(DemoUserKey.CHAIRMAN):
            await self.put(
                self.post(
                    NOTICE_GARAGES_ID,
                    DemoUserKey.CHAIRMAN,
                    post_type=PostType.OFFICIAL_NOTICE,
                    title="The garage gate code changes on Friday",
                    body="The new code is in your letterbox. The old code stops working on "
                    "Friday at 18:00.",
                    target_scope=TargetScope.KINDS,
                    target_kinds=[ObjectKind.GARAGE.value],
                    comments_enabled=False,
                    created_at=now - timedelta(hours=5),
                )
            )
            await self.put(
                self.post(
                    NOTICE_EVERYTHING_ID,
                    DemoUserKey.CHAIRMAN,
                    post_type=PostType.OFFICIAL_NOTICE,
                    category=PostCategory.MAINTENANCE,
                    title="The yard is closed on Saturday for asphalt work",
                    body="From 08:00 to 18:00 nobody can drive into the yard, the parking spaces "
                    "or the garages. Please move your car out on Friday evening.",
                    target_scope=TargetScope.ALL_OBJECTS,
                    comments_enabled=False,
                    created_at=now - timedelta(days=1),
                )
            )
            await self.put(
                self.post(
                    EMERGENCY_PARKING_ID,
                    DemoUserKey.CHAIRMAN,
                    post_type=PostType.EMERGENCY,
                    title="The parking gate is stuck open",
                    body="The service company comes today before 16:00. Until then the gate "
                    "stays open; please do not leave valuables in your car.",
                    target_scope=TargetScope.KINDS,
                    target_kinds=[ObjectKind.PARKING.value],
                    created_at=now - timedelta(hours=1),
                )
            )
        await self.topic()

    async def topic(self) -> None:
        """A forum topic of the board to the parking spaces and the garages (the board may address
        any target, a resident only the kinds they hold), with comments signed P1 and G12: each
        commenter's object inside the target."""
        if not await self.active(DemoUserKey.BOARD):
            return
        topic_at = self.now - timedelta(hours=6)
        await self.put(
            self.post(
                TOPIC_KINDS_ID,
                DemoUserKey.BOARD,
                post_type=PostType.FORUM_TOPIC,
                title="Who else wants a charger for electric cars?",
                body="Some of you asked about chargers. If enough of you want one, the board "
                "asks for a common offer for the parking spaces and the garages.",
                target_scope=TargetScope.KINDS,
                target_kinds=[ObjectKind.PARKING.value, ObjectKind.GARAGE.value],
                created_at=topic_at,
            )
        )
        # A comment added on a later start is timed from the stored topic, not from this start.
        created_at = await self.session.scalar(
            select(Post.created_at).where(Post.id == TOPIC_KINDS_ID)
        )
        if created_at is None:
            return
        for step, (comment_id, author, ref, body) in enumerate(_TOPIC_COMMENTS, start=1):
            if not await self.holds(author, ref):
                continue
            at = created_at + timedelta(hours=step)
            added = await self.put(
                Comment(
                    id=comment_id,
                    post_id=TOPIC_KINDS_ID,
                    building_id=DEMO_BUILDING_ID,
                    author_user_id=USERS[author].user_id,
                    author_apartment_id=demo_object_id(ref),
                    body=body,
                    created_at=at,
                )
            )
            if added:
                await self.session.execute(
                    update(Post)
                    .where(Post.id == TOPIC_KINDS_ID)
                    .values(last_activity_at=func.greatest(Post.last_activity_at, at))
                )

    async def poll(self) -> None:
        """An open poll to the parking spaces, one answer per object, nobody has answered yet."""
        if not await self.active(DemoUserKey.CHAIRMAN) or await self.exists(Poll, POLL_PARKING_ID):
            return  # an existing poll keeps its electorate
        electorate = [
            ref
            for key, ref in ((DemoUserKey.OWNER_14, P1), (DemoUserKey.TENANT_P2, P2))
            if await self.holds(key, ref)
        ]
        if not electorate:
            return
        now = self.now
        poll = Poll(
            id=POLL_PARKING_ID,
            building_id=DEMO_BUILDING_ID,
            created_by_user_id=USERS[DemoUserKey.CHAIRMAN].user_id,
            kind=PollKind.INFORMATIVE,
            title="Repaint the lines of the parking spaces",
            description="The lines are worn. Which colour should the new ones be?",
            target_scope=TargetScope.KINDS,
            target_kinds=[ObjectKind.PARKING.value],
            eligibility=Eligibility.RESIDENTS,
            unit=PollUnit.APARTMENT,
            status=PollStatus.OPEN,
            closes_at=now + timedelta(days=14),
            opened_at=now - timedelta(hours=3),
            created_at=now - timedelta(hours=4),
            updated_at=now - timedelta(hours=3),
        )
        if not await self.put(poll):
            return
        question_id = demo_id("poll:parking-lines:colour")
        await self.put(
            PollQuestion(
                id=question_id,
                poll_id=poll.id,
                building_id=DEMO_BUILDING_ID,
                position=1,
                text="Which colour?",
                answer_mode=AnswerMode.SINGLE_CHOICE,
                value_type=ValueType.TEXT,
                required=True,
            )
        )
        for position, colour in enumerate(("White", "Yellow"), start=1):
            await self.put(
                PollOption(
                    id=demo_id(f"poll:parking-lines:colour:{position}"),
                    question_id=question_id,
                    poll_id=poll.id,
                    position=position,
                    value=colour,
                )
            )
        for ref in electorate:
            await self.put(
                PollElector(
                    id=demo_id(f"poll:parking-lines:elector:{ref.kind.value}:{ref.number}"),
                    poll_id=poll.id,
                    building_id=DEMO_BUILDING_ID,
                    apartment_id=demo_object_id(ref),
                )
            )


async def complete_demo_building(session: AsyncSession, now: datetime) -> None:
    """Add what is missing of the demo building. Never raises: the start-up must go on."""
    completion = _Completion(session, now)
    try:
        async with session.begin_nested():
            await completion.run()
    except Exception as error:  # noqa: BLE001 - a broken demo must never stop the start-up
        # No message text: it may hold personal data (an e-mail in a unique violation).
        orig = getattr(error, "orig", None)
        logger.error(
            "seed_demo_completion_failed",
            step=completion.step,
            error_type=type(error).__name__,
            sqlstate=getattr(orig, "sqlstate", None),
            constraint=getattr(orig, "constraint_name", None),
        )
        return
    logger.info("seed_demo_completion_done")
