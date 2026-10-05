# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Rules of the research graph.

Work items with a ``research_type`` are nodes (question / hypothesis /
experiment / evidence); research relation types are typed edges. The model
follows Discourse Graphs (typed nodes and edges), IBIS (a grammar of which
node may link to which) and Analysis of Competing Hypotheses (verdicts must
rest on evidence).

Relations are stored in the forward direction: ``issue <type> related_issue``,
e.g. "hypothesis addresses question".
"""

# Django imports
from django.db import connection
from django.utils import timezone

# Module imports
from plane.db.models import Issue, IssueRelation, IssueResearchDetails
from plane.db.models.research import ResearchNodeType, ResearchStatus
from plane.utils.issue_relation_mapper import get_actual_relation, is_reverse_relation

QUESTION = ResearchNodeType.QUESTION.value
HYPOTHESIS = ResearchNodeType.HYPOTHESIS.value
EXPERIMENT = ResearchNodeType.EXPERIMENT.value
EVIDENCE = ResearchNodeType.EVIDENCE.value
ALL_NODE_TYPES = frozenset({QUESTION, HYPOTHESIS, EXPERIMENT, EVIDENCE})

INITIAL_STATUS = {
    QUESTION: ResearchStatus.OPEN.value,
    HYPOTHESIS: ResearchStatus.PROPOSED.value,
    EXPERIMENT: None,
    EVIDENCE: ResearchStatus.VALID.value,
}

ALLOWED_STATUSES = {
    QUESTION: {ResearchStatus.OPEN.value, ResearchStatus.ANSWERED.value, ResearchStatus.CLOSED.value},
    HYPOTHESIS: {
        ResearchStatus.PROPOSED.value,
        ResearchStatus.TESTING.value,
        ResearchStatus.CONFIRMED.value,
        ResearchStatus.REJECTED.value,
        ResearchStatus.INCONCLUSIVE.value,
        ResearchStatus.SUPERSEDED.value,
    },
    # Experiments are tracked by regular workflow states
    EXPERIMENT: {None},
    EVIDENCE: {ResearchStatus.VALID.value, ResearchStatus.INVALIDATED.value},
}

# Statuses that are computed and cannot be set by hand
COMPUTED_STATUSES = {ResearchStatus.ANSWERED.value}

VERDICT_STATUSES = {
    ResearchStatus.CONFIRMED.value,
    ResearchStatus.REJECTED.value,
    ResearchStatus.INCONCLUSIVE.value,
}

# relation type -> (allowed source node types, allowed target node types)
RELATION_GRAMMAR = {
    "addresses": (frozenset({HYPOTHESIS}), frozenset({QUESTION})),
    "tests": (frozenset({EXPERIMENT}), frozenset({HYPOTHESIS})),
    "produces": (frozenset({EXPERIMENT}), frozenset({EVIDENCE})),
    "supports": (frozenset({EVIDENCE}), frozenset({HYPOTHESIS})),
    "opposes": (frozenset({EVIDENCE}), frozenset({HYPOTHESIS})),
    "informs": (frozenset({EVIDENCE}), frozenset({QUESTION})),
    "raises": (ALL_NODE_TYPES, frozenset({QUESTION})),
    "derived_from": (frozenset({HYPOTHESIS}), frozenset({HYPOTHESIS})),
}
RESEARCH_RELATIONS = frozenset(RELATION_GRAMMAR)
WEIGHTED_RELATIONS = frozenset({"supports", "opposes"})
# With the grammar above a cycle can only appear through these relations
CYCLE_CHECKED_RELATIONS = ("raises", "derived_from")
# A verdict needs at least one valid evidence linked by this relation
VERDICT_BASIS = {
    ResearchStatus.CONFIRMED.value: "supports",
    ResearchStatus.REJECTED.value: "opposes",
}


class ResearchRuleError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def is_research_relation(relation_type):
    return get_actual_relation(relation_type) in RESEARCH_RELATIONS


def grammar_allows(relation_type, source_type, target_type):
    sources, targets = RELATION_GRAMMAR[relation_type]
    return source_type in sources and target_type in targets


def has_verdict_basis(hypothesis_id, status):
    relation_type = VERDICT_BASIS.get(status)
    if relation_type is None:
        return True
    return IssueRelation.objects.filter(
        related_issue_id=hypothesis_id,
        relation_type=relation_type,
        issue__research_type=EVIDENCE,
        issue__research_status=ResearchStatus.VALID.value,
        issue__deleted_at__isnull=True,
        issue__archived_at__isnull=True,
    ).exists()


def would_create_cycle(source_id, target_id):
    """True when adding source -> target closes a loop over cycle-checked relations."""
    if str(source_id) == str(target_id):
        return True
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH RECURSIVE reachable(node_id) AS (
                SELECT related_issue_id FROM issue_relations
                WHERE issue_id = %(start)s
                  AND relation_type = ANY(%(types)s)
                  AND deleted_at IS NULL
                UNION
                SELECT r.related_issue_id FROM issue_relations r
                JOIN reachable ON r.issue_id = reachable.node_id
                WHERE r.relation_type = ANY(%(types)s)
                  AND r.deleted_at IS NULL
            )
            SELECT 1 FROM reachable WHERE node_id = %(target)s LIMIT 1
            """,
            {"start": str(target_id), "target": str(source_id), "types": list(CYCLE_CHECKED_RELATIONS)},
        )
        return cursor.fetchone() is not None


def validate_research_relation(source, target, relation_type, weight=None):
    """Validate a forward (stored) research relation between two issues."""
    if source.id == target.id:
        raise ResearchRuleError("A work item cannot be related to itself")

    if not grammar_allows(relation_type, source.research_type, target.research_type):
        raise ResearchRuleError(
            f"'{relation_type}' cannot link {source.research_type or 'a regular work item'} "
            f"to {target.research_type or 'a regular work item'}"
        )

    if relation_type in WEIGHTED_RELATIONS:
        if weight not in (1, 2, 3):
            raise ResearchRuleError(f"'{relation_type}' requires a weight of 1, 2 or 3")
    elif weight is not None:
        raise ResearchRuleError(f"'{relation_type}' does not take a weight")

    # One relation per pair of nodes, in either direction
    existing = (
        IssueRelation.objects.filter(issue_id=source.id, related_issue_id=target.id)
        | IssueRelation.objects.filter(issue_id=target.id, related_issue_id=source.id)
    ).first()
    if existing is not None:
        raise ResearchRuleError(
            f"These work items are already related ('{existing.relation_type}')",
            status_code=409,
        )

    if relation_type in CYCLE_CHECKED_RELATIONS and would_create_cycle(source.id, target.id):
        raise ResearchRuleError("This relation would create a cycle")


def prepare_relation_pairs(issue_id, relation_type, related_issue_ids, workspace_slug, weight=None):
    """
    Turn a request "issue_id <relation_type> each of related_issue_ids" into
    stored (issue_id, related_issue_id) pairs, validating research relations.

    Returns (stored_relation_type, pairs, is_research).
    """
    stored_type = get_actual_relation(relation_type)
    reverse = is_reverse_relation(relation_type)
    pairs = [(related, issue_id) if reverse else (issue_id, related) for related in related_issue_ids]

    if stored_type not in RESEARCH_RELATIONS:
        if weight is not None:
            raise ResearchRuleError(f"'{relation_type}' does not take a weight")
        return stored_type, pairs, False

    if len(set(map(str, related_issue_ids))) != len(related_issue_ids):
        raise ResearchRuleError("Duplicate work items in the request")

    issues = {
        str(issue.id): issue
        for issue in Issue.issue_objects.filter(
            workspace__slug=workspace_slug, pk__in=[issue_id, *related_issue_ids]
        ).only("id", "research_type")
    }
    for source_id, target_id in pairs:
        source = issues.get(str(source_id))
        target = issues.get(str(target_id))
        if source is None or target is None:
            raise ResearchRuleError("Work item not found", status_code=404)
        validate_research_relation(source, target, stored_type, weight)

    return stored_type, pairs, True


def validate_research_attrs(instance, attrs):
    """
    Validate and normalise research_type / research_status on an issue write.

    ``instance`` is None on create. Mutates and returns ``attrs``.
    """
    current_type = instance.research_type if instance else None
    current_status = instance.research_status if instance else None

    new_type = attrs["research_type"] if "research_type" in attrs else current_type
    type_changed = new_type != current_type
    status_given = "research_status" in attrs

    if not status_given and not type_changed:
        return attrs

    if status_given:
        new_status = attrs["research_status"]
        if new_status is None and new_type is not None:
            new_status = INITIAL_STATUS[new_type]
    else:
        new_status = INITIAL_STATUS.get(new_type) if new_type else None

    if new_type is None:
        if new_status is not None:
            raise ResearchRuleError("research_status requires a research_type")
    else:
        if new_status not in ALLOWED_STATUSES[new_type]:
            raise ResearchRuleError(f"'{new_status}' is not a valid status for a {new_type}")
        if status_given and new_status in COMPUTED_STATUSES and new_status != current_status:
            raise ResearchRuleError(f"'{new_status}' is computed and cannot be set manually")

    if instance is not None and type_changed:
        _validate_type_change(instance, new_type)

    status_changed = new_status != current_status or type_changed
    if status_changed and new_status in VERDICT_BASIS:
        if instance is None or not has_verdict_basis(instance.id, new_status):
            relation = VERDICT_BASIS[new_status]
            raise ResearchRuleError(
                f"A hypothesis can be {new_status} only with at least one valid evidence that {relation} it"
            )

    attrs["research_status"] = new_status
    return attrs


def _validate_type_change(instance, new_type):
    outgoing = IssueRelation.objects.filter(issue_id=instance.id, relation_type__in=RESEARCH_RELATIONS).select_related(
        "related_issue"
    )
    for relation in outgoing:
        if not grammar_allows(relation.relation_type, new_type, relation.related_issue.research_type):
            raise ResearchRuleError(
                f"Cannot change the type: the '{relation.relation_type}' relation would become invalid"
            )
    incoming = IssueRelation.objects.filter(
        related_issue_id=instance.id, relation_type__in=RESEARCH_RELATIONS
    ).select_related("issue")
    for relation in incoming:
        if not grammar_allows(relation.relation_type, relation.issue.research_type, new_type):
            raise ResearchRuleError(
                f"Cannot change the type: the '{relation.relation_type}' relation would become invalid"
            )


def recheck_verdict_basis(hypothesis_ids):
    """Flag hypotheses whose confirmed / rejected verdict no longer rests on valid evidence."""
    hypotheses = Issue.objects.filter(pk__in=list(hypothesis_ids), research_type=HYPOTHESIS).only(
        "id", "research_status", "needs_review"
    )
    for hypothesis in hypotheses:
        needs_review = hypothesis.research_status in VERDICT_BASIS and not has_verdict_basis(
            hypothesis.id, hypothesis.research_status
        )
        if needs_review != hypothesis.needs_review:
            Issue.objects.filter(pk=hypothesis.id).update(needs_review=needs_review)


def recompute_question_status(question_ids):
    """A question is answered while one of its hypotheses is confirmed; closed is left alone."""
    questions = Issue.objects.filter(
        pk__in=list(question_ids),
        research_type=QUESTION,
        research_status__in=[ResearchStatus.OPEN.value, ResearchStatus.ANSWERED.value],
    ).only("id", "research_status")
    for question in questions:
        answered = IssueRelation.objects.filter(
            related_issue_id=question.id,
            relation_type="addresses",
            issue__research_type=HYPOTHESIS,
            issue__research_status=ResearchStatus.CONFIRMED.value,
            issue__deleted_at__isnull=True,
            issue__archived_at__isnull=True,
        ).exists()
        new_status = ResearchStatus.ANSWERED.value if answered else ResearchStatus.OPEN.value
        if new_status != question.research_status:
            Issue.objects.filter(pk=question.id).update(research_status=new_status)


def apply_issue_research_side_effects(issue, previous_type, previous_status, actor_id=None):
    """Run after an issue write that may have changed research_type / research_status."""
    if issue.research_type == previous_type and issue.research_status == previous_status:
        return

    if issue.research_type == HYPOTHESIS:
        _record_verdict(issue, actor_id)
    if HYPOTHESIS in (issue.research_type, previous_type):
        recheck_verdict_basis([issue.id])
        recompute_question_status(
            IssueRelation.objects.filter(issue_id=issue.id, relation_type="addresses").values_list(
                "related_issue_id", flat=True
            )
        )
    if EVIDENCE in (issue.research_type, previous_type):
        recheck_verdict_basis(
            IssueRelation.objects.filter(issue_id=issue.id, relation_type__in=WEIGHTED_RELATIONS).values_list(
                "related_issue_id", flat=True
            )
        )
    if issue.research_type == QUESTION:
        recompute_question_status([issue.id])


def apply_relation_side_effects(relation_type, issue_id, related_issue_id):
    """Run after a stored relation is created, changed or removed."""
    if relation_type in WEIGHTED_RELATIONS:
        recheck_verdict_basis([related_issue_id])
    elif relation_type == "addresses":
        recompute_question_status([related_issue_id])


def _record_verdict(issue, actor_id):
    details, _ = IssueResearchDetails.objects.get_or_create(
        issue_id=issue.id,
        defaults={"project_id": issue.project_id, "workspace_id": issue.workspace_id},
    )
    if issue.research_status in VERDICT_STATUSES:
        details.verdict_at = timezone.now()
        details.verdict_by_id = actor_id
    else:
        details.verdict_at = None
        details.verdict_by_id = None
    details.save(update_fields=["verdict_at", "verdict_by", "updated_at"])
