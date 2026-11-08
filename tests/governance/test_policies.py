"""Unit tests of the pure governance rules (no database)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from src.modules.governance.policies import (
    AnswerProblem,
    CheckedAnswer,
    GivenAnswer,
    QuestionSpec,
    ResultQuestion,
    canonical_value,
    check_ballot,
    effective_status,
    electorate_units,
    results_available,
    tally,
    target_problem,
)
from src.modules.governance.schemas import AnswerMode, PollStatus, PollUnit, ValueType
from src.modules.property.schemas import TargetScope


@pytest.mark.parametrize(
    ("value_type", "raw", "canonical"),
    [
        (ValueType.NUMBER, "2", "2"),
        (ValueType.NUMBER, " 2.50 ", "2.5"),
        (ValueType.NUMBER, "-0.000", "0"),
        (ValueType.NUMBER, "100", "100"),
        (ValueType.NUMBER, "0.000001", "0.000001"),
        (ValueType.DATE, "2026-04-12", "2026-04-12"),
        (ValueType.TEXT, "  Gloves  ", "Gloves"),
    ],
)
def test_values_are_made_canonical(value_type: ValueType, raw: str, canonical: str) -> None:
    assert canonical_value(value_type, raw, max_length=200) == canonical


@pytest.mark.parametrize(
    ("value_type", "raw"),
    [
        (ValueType.NUMBER, "1e3"),
        (ValueType.NUMBER, "1,5"),
        (ValueType.NUMBER, "1234567890123"),
        (ValueType.NUMBER, "0.0000001"),
        (ValueType.DATE, "2026-02-30"),
        (ValueType.DATE, "12.04.2026"),
        (ValueType.TEXT, "   "),
        (ValueType.TEXT, "bell\x07"),
        (ValueType.TEXT, "x" * 201),
    ],
)
def test_invalid_values_are_refused(value_type: ValueType, raw: str) -> None:
    with pytest.raises(ValueError):
        canonical_value(value_type, raw, max_length=200)


def test_a_passed_deadline_closes_an_open_poll_only() -> None:
    now = datetime(2026, 11, 5, 12, tzinfo=UTC)
    past, future = now - timedelta(seconds=1), now + timedelta(seconds=1)

    assert effective_status(PollStatus.OPEN, past, now) == PollStatus.CLOSED
    assert effective_status(PollStatus.OPEN, now, now) == PollStatus.CLOSED
    assert effective_status(PollStatus.OPEN, future, now) == PollStatus.OPEN
    assert effective_status(PollStatus.DRAFT, past, now) == PollStatus.DRAFT
    assert effective_status(PollStatus.CANCELLED, past, now) == PollStatus.CANCELLED


def test_the_units_are_apartments_or_people_once_each() -> None:
    owner, family, tenant = (uuid.uuid4() for _ in range(3))
    apt_14, apt_2 = uuid.uuid4(), uuid.uuid4()
    pairs = [(owner, apt_14), (family, apt_14), (tenant, apt_2), (owner, apt_2)]

    assert set(electorate_units(PollUnit.APARTMENT, pairs)) == {apt_14, apt_2}
    assert set(electorate_units(PollUnit.PERSON, pairs)) == {owner, family, tenant}
    assert len(electorate_units(PollUnit.PERSON, pairs)) == 3


def test_targets_follow_the_rules_of_posts() -> None:
    one = [uuid.uuid4()]
    assert target_problem(TargetScope.ALL_BUILDING, None, None) is None
    assert target_problem(TargetScope.ENTRANCE, 2, None) is None
    assert target_problem(TargetScope.APARTMENT_LIST, None, one) is None
    assert target_problem(TargetScope.ALL_BUILDING, 2, None)
    assert target_problem(TargetScope.ENTRANCE, None, None)
    assert target_problem(TargetScope.ENTRANCE, 2, one)
    assert target_problem(TargetScope.APARTMENT_LIST, None, None)
    assert target_problem(TargetScope.APARTMENT_LIST, 2, one)


A, B, C = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
CHOICE = QuestionSpec(
    id=uuid.uuid4(),
    answer_mode=AnswerMode.MULTIPLE_CHOICE,
    value_type=ValueType.DATE,
    required=True,
    min_choices=1,
    max_choices=2,
    min_value=None,
    max_value=None,
    option_ids=frozenset({A, B, C}),
)
DAY = QuestionSpec(
    id=uuid.uuid4(),
    answer_mode=AnswerMode.OWN_VALUE,
    value_type=ValueType.DATE,
    required=False,
    min_choices=None,
    max_choices=None,
    min_value="2026-04-01",
    max_value="2026-04-30",
    option_ids=frozenset(),
)


def test_a_ballot_is_checked_and_ordered_by_the_questions() -> None:
    checked = check_ballot(
        [CHOICE, DAY],
        [GivenAnswer(DAY.id, None, "2026-04-12"), GivenAnswer(CHOICE.id, [B, A], None)],
    )

    assert [answer.question_id for answer in checked] == [CHOICE.id, DAY.id]
    assert checked[0].option_ids == (B, A)
    assert checked[1].value == "2026-04-12"
    assert check_ballot([CHOICE, DAY], [GivenAnswer(CHOICE.id, [C], None)])[0].option_ids == (C,)


@pytest.mark.parametrize(
    ("answers", "reason"),
    [
        ([], "REQUIRED"),
        ([GivenAnswer(CHOICE.id, [A, B, C], None)], "CHOICES"),
        ([GivenAnswer(CHOICE.id, [A, A], None)], "DUPLICATE"),
        ([GivenAnswer(CHOICE.id, [uuid.uuid4()], None)], "UNKNOWN_OPTION"),
        (
            [GivenAnswer(CHOICE.id, [A], None), GivenAnswer(DAY.id, None, "2026-05-01")],
            "OUT_OF_RANGE",
        ),
        ([GivenAnswer(CHOICE.id, [A], None), GivenAnswer(DAY.id, None, "soon")], "VALUE"),
        ([GivenAnswer(CHOICE.id, [A], None), GivenAnswer(DAY.id, [A], None)], "VALUE"),
    ],
)
def test_a_ballot_that_does_not_fit_is_refused(answers: list, reason: str) -> None:
    with pytest.raises(AnswerProblem) as problem:
        check_ballot([CHOICE, DAY], answers)

    assert problem.value.reason == reason


# --- Results -------------------------------------------------------------------------------------


def _question(mode: AnswerMode, value_type: ValueType, options: int = 0) -> ResultQuestion:
    return ResultQuestion(
        id=uuid.uuid4(),
        answer_mode=mode,
        value_type=value_type,
        option_ids=tuple(uuid.uuid4() for _ in range(options)),
    )


def _own(question: ResultQuestion, value: str) -> list[CheckedAnswer]:
    return [CheckedAnswer(question_id=question.id, option_ids=(), value=value)]


@pytest.mark.parametrize(
    ("values", "average"),
    [
        (["1", "1", "2"], "1.333333"),
        (["0.000001", "0.000002"], "0.000002"),  # 0.0000015, half-even
        (["0.000001", "0"], "0"),  # 0.0000005, half-even to the even 0
        (["-2", "2"], "0"),
        (["999999999999.999999", "999999999999.999999"], "999999999999.999999"),
    ],
)
def test_the_average_of_own_numbers_is_exact_and_rounded_half_even(
    values: list[str], average: str
) -> None:
    question = _question(AnswerMode.OWN_VALUE, ValueType.NUMBER)

    _, [result] = tally([question], 5, [_own(question, value) for value in values], with_texts=True)

    assert result.number is not None and result.number.average == average
    assert result.answered == len(values)


def test_totals_count_options_dates_and_texts() -> None:
    choice = _question(AnswerMode.MULTIPLE_CHOICE, ValueType.TEXT, options=3)
    day = _question(AnswerMode.OWN_VALUE, ValueType.DATE)
    number = _question(AnswerMode.OWN_VALUE, ValueType.NUMBER)
    note = _question(AnswerMode.OWN_VALUE, ValueType.TEXT)
    a, b, c = choice.option_ids
    ballots = [
        [CheckedAnswer(choice.id, (a, c), None), *_own(day, "2026-05-02"), *_own(note, "b")],
        [CheckedAnswer(choice.id, (c,), None), *_own(day, "2026-04-30"), *_own(note, "B")],
        [*_own(day, "2026-05-02"), *_own(note, "a")],
        [],  # answered nothing (all optional), still took part
    ]

    participation, [chosen, days, numbers, notes] = tally(
        [choice, day, number, note], 6, ballots, with_texts=True
    )

    assert (participation.answered, participation.electorate) == (4, 6)
    assert chosen.answered == 2
    assert [(o.option_id, o.count) for o in chosen.options or []] == [(a, 1), (b, 0), (c, 2)]
    assert [(d.value, d.count) for d in days.dates or []] == [("2026-04-30", 1), ("2026-05-02", 2)]
    assert (numbers.answered, numbers.number) == (0, None)
    assert [(t.value, t.count) for t in notes.texts or []] == [("a", 1), ("B", 1), ("b", 1)]
    assert (chosen.number, chosen.dates, chosen.texts, days.options) == (None, None, None, None)


def test_texts_stay_hidden_without_permission() -> None:
    note = _question(AnswerMode.OWN_VALUE, ValueType.TEXT)

    _, [result] = tally([note], 1, [_own(note, "secret")], with_texts=False)

    assert (result.answered, result.texts) == (1, None)


@pytest.mark.parametrize(
    ("status", "board", "available"),
    [
        (PollStatus.DRAFT, True, False),
        (PollStatus.OPEN, True, True),
        (PollStatus.OPEN, False, False),
        (PollStatus.CLOSED, False, True),
        (PollStatus.CANCELLED, True, False),
    ],
)
def test_who_sees_results_when(status: PollStatus, board: bool, available: bool) -> None:
    assert results_available(status, board=board) is available
