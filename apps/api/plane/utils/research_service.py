# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Research graph operations shared by the app API (session auth) and the
public v1 API (API keys): visibility, merging hypotheses, collecting a graph
and the Analysis of Competing Hypotheses matrix.
"""

# Python imports
import json

# Django imports
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

# Module imports
from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import Cycle, Issue, IssueRelation, IssueView, Module, ProjectMember, ResearchGraphLayout
from plane.db.models.research import ResearchStatus
from plane.utils.research_grammar import (
    EVIDENCE,
    HYPOTHESIS,
    QUESTION,
    RESEARCH_RELATIONS,
    WEIGHTED_RELATIONS,
    ResearchRuleError,
    recheck_verdict_basis,
    recompute_question_status,
)

MAX_GRAPH_NODES = 2000
GUEST_ROLE = 5


def visible_issues(user, slug, project_id):
    """Work items of a project the user may see: guests without full access only see their own."""
    issues = Issue.issue_objects.filter(workspace__slug=slug, project_id=project_id)
    is_restricted_guest = ProjectMember.objects.filter(
        workspace__slug=slug,
        project_id=project_id,
        member=user,
        role=GUEST_ROLE,
        is_active=True,
        project__guest_view_all_features=False,
    ).exists()
    return issues.filter(created_by=user) if is_restricted_guest else issues


def scope_exists(scope_type, scope_id, project_id):
    if scope_type == ResearchGraphLayout.ScopeType.PROJECT:
        return str(scope_id) == str(project_id)
    model = {
        ResearchGraphLayout.ScopeType.CYCLE: Cycle,
        ResearchGraphLayout.ScopeType.MODULE: Module,
        ResearchGraphLayout.ScopeType.VIEW: IssueView,
    }.get(scope_type)
    return model is not None and model.objects.filter(pk=scope_id, project_id=project_id).exists()


def filter_by_scope(queryset, scope_type, scope_id):
    if scope_type == ResearchGraphLayout.ScopeType.CYCLE:
        return queryset.filter(issue_cycle__cycle_id=scope_id, issue_cycle__deleted_at__isnull=True)
    if scope_type == ResearchGraphLayout.ScopeType.MODULE:
        return queryset.filter(issue_module__module_id=scope_id, issue_module__deleted_at__isnull=True)
    # project and project view scopes: the caller applies the view's filters
    return queryset


def merge_hypotheses(user, visible, project_id, hypothesis_ids, name, origin):
    """
    Create a hypothesis derived from all given hypotheses, carry over the
    questions they address and mark them superseded. Returns (merged, question_ids).
    """
    sources = list(visible.filter(pk__in=hypothesis_ids, research_type=HYPOTHESIS))
    if len(sources) != len(set(map(str, hypothesis_ids))):
        raise ResearchRuleError("All merged work items must be hypotheses of this project")
    question_ids = list(
        IssueRelation.objects.filter(
            issue_id__in=hypothesis_ids,
            relation_type="addresses",
            related_issue__research_type=QUESTION,
            related_issue__deleted_at__isnull=True,
        )
        # the model's default ordering would otherwise leak into SELECT DISTINCT and keep duplicates
        .order_by()
        .values_list("related_issue_id", flat=True)
        .distinct()
    )

    with transaction.atomic():
        merged = Issue(
            name=name,
            project_id=project_id,
            research_type=HYPOTHESIS,
            research_status=ResearchStatus.PROPOSED.value,
        )
        merged.save()
        IssueRelation.objects.bulk_create(
            [
                IssueRelation(
                    issue=merged,
                    related_issue_id=target_id,
                    relation_type=relation_type,
                    project_id=project_id,
                    workspace_id=merged.workspace_id,
                    created_by=user,
                    updated_by=user,
                )
                for relation_type, target_ids in (("derived_from", hypothesis_ids), ("addresses", question_ids))
                for target_id in target_ids
            ]
        )
        previous_statuses = {str(source.id): source.research_status for source in sources}
        Issue.objects.filter(pk__in=hypothesis_ids).update(
            research_status=ResearchStatus.SUPERSEDED.value, updated_at=timezone.now()
        )
        # A superseded hypothesis no longer answers a question
        recheck_verdict_basis(hypothesis_ids)
        recompute_question_status(question_ids)

    _log_merge_activity(user, project_id, merged, hypothesis_ids, question_ids, previous_statuses, origin)
    return merged, question_ids


def _log_merge_activity(user, project_id, merged, hypothesis_ids, question_ids, previous_statuses, origin):
    common = {
        "actor_id": str(user.id),
        "project_id": str(project_id),
        "epoch": int(timezone.now().timestamp()),
        "notification": True,
        "origin": origin,
    }
    issue_activity.delay(
        type="issue.activity.created",
        requested_data=json.dumps({"name": merged.name, "research_type": HYPOTHESIS}),
        issue_id=str(merged.id),
        current_instance=None,
        **common,
    )
    for relation_type, target_ids in (("derived_from", hypothesis_ids), ("addresses", question_ids)):
        if target_ids:
            issue_activity.delay(
                type="issue_relation.activity.created",
                requested_data=json.dumps(
                    {"issues": [str(target_id) for target_id in target_ids], "relation_type": relation_type},
                    cls=DjangoJSONEncoder,
                ),
                issue_id=str(merged.id),
                current_instance=None,
                **common,
            )
    for hypothesis_id in hypothesis_ids:
        issue_activity.delay(
            type="issue.activity.updated",
            requested_data=json.dumps({"research_status": ResearchStatus.SUPERSEDED.value}),
            issue_id=str(hypothesis_id),
            current_instance=json.dumps({"research_status": previous_statuses.get(str(hypothesis_id))}),
            **common,
        )


def collect_graph(visible, queryset):
    """
    Node ids matching `queryset`, research neighbours outside it (ghosts, so the
    graph does not break apart) and the edges between them.
    Returns (node_ids, ghost_ids, edges, truncated).
    """
    node_ids = list(queryset.order_by("created_at").values_list("id", flat=True).distinct()[: MAX_GRAPH_NODES + 1])
    truncated = len(node_ids) > MAX_GRAPH_NODES
    node_ids = set(node_ids[:MAX_GRAPH_NODES])

    relations = list(
        IssueRelation.objects.filter(Q(issue_id__in=node_ids) | Q(related_issue_id__in=node_ids)).values(
            "id", "issue_id", "related_issue_id", "relation_type", "weight"
        )
    )
    neighbour_ids = {
        other
        for relation in relations
        if relation["relation_type"] in RESEARCH_RELATIONS
        for other in (relation["issue_id"], relation["related_issue_id"])
        if other not in node_ids
    }
    ghost_ids = (
        set(visible.filter(pk__in=neighbour_ids, research_type__isnull=False).values_list("id", flat=True))
        if neighbour_ids
        else set()
    )
    all_ids = node_ids | ghost_ids

    edges = [
        {
            "id": relation["id"],
            "source": relation["issue_id"],
            "target": relation["related_issue_id"],
            "relation_type": relation["relation_type"],
            "weight": relation["weight"],
        }
        for relation in relations
        if (
            relation["relation_type"] in RESEARCH_RELATIONS
            and relation["issue_id"] in all_ids
            and relation["related_issue_id"] in all_ids
        )
        # Regular relations only between nodes that matched the filter
        or (relation["issue_id"] in node_ids and relation["related_issue_id"] in node_ids)
    ]
    return node_ids, ghost_ids, edges, truncated


def build_matrix(visible, question):
    """
    Analysis of Competing Hypotheses for a question: hypotheses ranked by the
    weight of valid evidence against them, and which evidence tells them apart.
    """
    lite_fields = ("id", "name", "sequence_id", "research_status", "needs_review")
    hypotheses = list(
        visible.filter(
            research_type=HYPOTHESIS,
            issue_relation__related_issue_id=question.id,
            issue_relation__relation_type="addresses",
            issue_relation__deleted_at__isnull=True,
        )
        .order_by()
        .distinct()
        .values(*lite_fields)
    )
    hypothesis_ids = [hypothesis["id"] for hypothesis in hypotheses]

    cells = list(
        IssueRelation.objects.filter(
            related_issue_id__in=hypothesis_ids,
            relation_type__in=WEIGHTED_RELATIONS,
            issue__in=visible.filter(research_type=EVIDENCE),
        ).values("issue_id", "related_issue_id", "relation_type", "weight")
    )
    informing_ids = IssueRelation.objects.filter(related_issue_id=question.id, relation_type="informs").values_list(
        "issue_id", flat=True
    )
    evidence_ids = {cell["issue_id"] for cell in cells} | set(informing_ids)
    evidence = list(visible.filter(pk__in=evidence_ids, research_type=EVIDENCE).values(*lite_fields))
    valid_evidence_ids = {item["id"] for item in evidence if item["research_status"] == ResearchStatus.VALID.value}

    # ACH ranks by disconfirmation: the hypothesis with the least weight against it leads
    scores = {hypothesis_id: {"inconsistency": 0, "support": 0} for hypothesis_id in hypothesis_ids}
    by_evidence = {}
    for cell in cells:
        by_evidence.setdefault(cell["issue_id"], {})[cell["related_issue_id"]] = (
            cell["relation_type"],
            cell["weight"],
        )
        if cell["issue_id"] not in valid_evidence_ids:
            continue
        key = "inconsistency" if cell["relation_type"] == "opposes" else "support"
        scores[cell["related_issue_id"]][key] += cell["weight"] or 0

    ranked = sorted(
        hypotheses,
        key=lambda item: (scores[item["id"]]["inconsistency"], -scores[item["id"]]["support"]),
    )
    for rank, hypothesis in enumerate(ranked, start=1):
        hypothesis.update(scores[hypothesis["id"]], rank=rank)

    for item in evidence:
        row = by_evidence.get(item["id"], {})
        # Evidence that rates every hypothesis the same cannot tell them apart
        item["diagnostic"] = not (
            len(hypothesis_ids) > 1 and len(row) == len(hypothesis_ids) and len(set(row.values())) == 1
        )

    return {
        "question": {key: getattr(question, key) for key in lite_fields},
        "hypotheses": ranked,
        "evidence": evidence,
        "cells": [
            {
                "evidence_id": cell["issue_id"],
                "hypothesis_id": cell["related_issue_id"],
                "relation_type": cell["relation_type"],
                "weight": cell["weight"],
            }
            for cell in cells
        ],
    }
