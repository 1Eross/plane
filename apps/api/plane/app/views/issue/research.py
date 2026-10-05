# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json

# Django imports
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

# Third Party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.research import (
    IssueResearchDetailsSerializer,
    ResearchGraphLayoutSerializer,
    ResearchMergeSerializer,
)
from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import (
    Cycle,
    Issue,
    IssueRelation,
    IssueResearchDetails,
    IssueView,
    Module,
    ProjectMember,
    ResearchGraphLayout,
)
from plane.db.models.research import ResearchStatus
from plane.utils.filters import ComplexFilterBackend, IssueFilterSet
from plane.utils.grouper import issue_queryset_grouper
from plane.utils.host import base_host
from plane.utils.issue_filters import issue_filters
from plane.utils.research_grammar import (
    EVIDENCE,
    HYPOTHESIS,
    QUESTION,
    RESEARCH_RELATIONS,
    WEIGHTED_RELATIONS,
    recheck_verdict_basis,
    recompute_question_status,
)
from plane.utils.timezone_converter import user_timezone_converter

from .. import BaseAPIView
from .base import IssueViewSet

MAX_GRAPH_NODES = 2000

# Same shape as the issue list, so the client can put nodes into its issue store
NODE_FIELDS = [
    "id",
    "name",
    "state_id",
    "sort_order",
    "completed_at",
    "estimate_point",
    "priority",
    "start_date",
    "target_date",
    "sequence_id",
    "project_id",
    "parent_id",
    "cycle_id",
    "module_ids",
    "label_ids",
    "assignee_ids",
    "sub_issues_count",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "attachment_count",
    "link_count",
    "is_draft",
    "archived_at",
    "research_type",
    "research_status",
    "needs_review",
]


def _is_restricted_guest(request, slug, project_id):
    # Guests without full feature access only see work items they created
    return ProjectMember.objects.filter(
        workspace__slug=slug,
        project_id=project_id,
        member=request.user,
        role=ROLE.GUEST.value,
        is_active=True,
        project__guest_view_all_features=False,
    ).exists()


def _visible_issues(request, slug, project_id):
    issues = Issue.issue_objects.filter(workspace__slug=slug, project_id=project_id)
    if _is_restricted_guest(request, slug, project_id):
        issues = issues.filter(created_by=request.user)
    return issues


def _scope_exists(scope_type, scope_id, project_id):
    if scope_type == ResearchGraphLayout.ScopeType.PROJECT:
        return str(scope_id) == str(project_id)
    model = {
        ResearchGraphLayout.ScopeType.CYCLE: Cycle,
        ResearchGraphLayout.ScopeType.MODULE: Module,
        ResearchGraphLayout.ScopeType.VIEW: IssueView,
    }.get(scope_type)
    return model is not None and model.objects.filter(pk=scope_id, project_id=project_id).exists()


class IssueResearchEndpoint(BaseAPIView):
    """Research details of one node; type and status change through the issue itself."""

    def _get_issue(self, request, slug, project_id, issue_id):
        return _visible_issues(request, slug, project_id).filter(pk=issue_id).first()

    def _response(self, issue, details):
        data = IssueResearchDetailsSerializer(details).data if details else {"issue_id": issue.id}
        data.update(
            {
                "research_type": issue.research_type,
                "research_status": issue.research_status,
                "needs_review": issue.needs_review,
            }
        )
        return data

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, issue_id):
        issue = self._get_issue(request, slug, project_id, issue_id)
        if issue is None:
            return Response({"error": "Work item not found"}, status=status.HTTP_404_NOT_FOUND)
        details = IssueResearchDetails.objects.filter(issue_id=issue.id).first()
        return Response(self._response(issue, details), status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def patch(self, request, slug, project_id, issue_id):
        issue = self._get_issue(request, slug, project_id, issue_id)
        if issue is None:
            return Response({"error": "Work item not found"}, status=status.HTTP_404_NOT_FOUND)
        if issue.research_type is None:
            return Response(
                {"error": "Set a research type on the work item first"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        details = IssueResearchDetails.objects.filter(issue_id=issue.id).first()
        serializer = IssueResearchDetailsSerializer(details, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        details = serializer.save(issue_id=issue.id, project_id=issue.project_id, workspace_id=issue.workspace_id)
        return Response(self._response(issue, details), status=status.HTTP_200_OK)


class ResearchMergeEndpoint(BaseAPIView):
    """Merge hypotheses into a new one derived from all of them."""

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def post(self, request, slug, project_id):
        serializer = ResearchMergeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        hypothesis_ids = serializer.validated_data["hypothesis_ids"]

        sources = list(
            _visible_issues(request, slug, project_id).filter(pk__in=hypothesis_ids, research_type=HYPOTHESIS)
        )
        if len(sources) != len(hypothesis_ids):
            return Response(
                {"error": "All merged work items must be hypotheses of this project"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        question_ids = list(
            IssueRelation.objects.filter(
                issue_id__in=hypothesis_ids,
                relation_type="addresses",
                related_issue__research_type=QUESTION,
                related_issue__deleted_at__isnull=True,
            )
            .values_list("related_issue_id", flat=True)
            .distinct()
        )

        with transaction.atomic():
            merged = Issue(
                name=serializer.validated_data["name"],
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
                        created_by=request.user,
                        updated_by=request.user,
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

        self._log_activity(request, project_id, merged, hypothesis_ids, question_ids, previous_statuses)

        return Response(
            {
                "issue": _serialize_nodes(Issue.issue_objects.filter(pk=merged.id), request)[0],
                "derived_from": [str(hypothesis_id) for hypothesis_id in hypothesis_ids],
                "addresses": [str(question_id) for question_id in question_ids],
            },
            status=status.HTTP_201_CREATED,
        )

    def _log_activity(self, request, project_id, merged, hypothesis_ids, question_ids, previous_statuses):
        epoch = int(timezone.now().timestamp())
        common = {
            "actor_id": str(request.user.id),
            "project_id": str(project_id),
            "epoch": epoch,
            "notification": True,
            "origin": base_host(request=request, is_app=True),
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


def _serialize_nodes(queryset, request):
    queryset = IssueViewSet().apply_annotations(queryset)
    queryset = issue_queryset_grouper(queryset=queryset, group_by=None, sub_group_by=None)
    nodes = list(queryset.values(*NODE_FIELDS))
    return user_timezone_converter(nodes, ["created_at", "updated_at"], request.user.user_timezone)


class ResearchGraphEndpoint(BaseAPIView):
    """Nodes, out-of-filter neighbours (ghosts) and edges of a scope in one response."""

    filter_backends = (ComplexFilterBackend,)
    filterset_class = IssueFilterSet

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id):
        scope_type = request.GET.get("scope_type", ResearchGraphLayout.ScopeType.PROJECT)
        scope_id = request.GET.get("scope_id", str(project_id))
        if scope_type not in ResearchGraphLayout.ScopeType.values or not _scope_exists(
            scope_type, scope_id, project_id
        ):
            return Response({"error": "Invalid scope"}, status=status.HTTP_400_BAD_REQUEST)

        visible = _visible_issues(request, slug, project_id).filter(research_type__isnull=False)
        queryset = visible
        if scope_type == ResearchGraphLayout.ScopeType.CYCLE:
            queryset = queryset.filter(issue_cycle__cycle_id=scope_id, issue_cycle__deleted_at__isnull=True)
        elif scope_type == ResearchGraphLayout.ScopeType.MODULE:
            queryset = queryset.filter(issue_module__module_id=scope_id, issue_module__deleted_at__isnull=True)
        # A project view sends its own filters with the request, like the issue list does

        queryset = self.filter_queryset(queryset)
        queryset = queryset.filter(**issue_filters(request.query_params, "GET"))

        node_ids = list(queryset.order_by("created_at").values_list("id", flat=True).distinct()[: MAX_GRAPH_NODES + 1])
        truncated = len(node_ids) > MAX_GRAPH_NODES
        node_ids = set(node_ids[:MAX_GRAPH_NODES])

        relations = list(
            IssueRelation.objects.filter(Q(issue_id__in=node_ids) | Q(related_issue_id__in=node_ids)).values(
                "id", "issue_id", "related_issue_id", "relation_type", "weight"
            )
        )

        # Research neighbours outside the filter are shown as ghosts so the graph does not break apart
        neighbour_ids = {
            other
            for relation in relations
            if relation["relation_type"] in RESEARCH_RELATIONS
            for other in (relation["issue_id"], relation["related_issue_id"])
            if other not in node_ids
        }
        ghost_ids = set(visible.filter(pk__in=neighbour_ids).values_list("id", flat=True)) if neighbour_ids else set()
        all_ids = node_ids | ghost_ids

        nodes = _serialize_nodes(Issue.issue_objects.filter(pk__in=all_ids), request) if all_ids else []
        for node in nodes:
            node["is_ghost"] = node["id"] in ghost_ids

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

        return Response({"nodes": nodes, "edges": edges, "truncated": truncated}, status=status.HTTP_200_OK)


class ResearchGraphLayoutEndpoint(BaseAPIView):
    """Shared node positions and collapsed branches of one research graph scope."""

    def _validate_scope(self, scope_type, scope_id, project_id):
        if scope_type not in ResearchGraphLayout.ScopeType.values or not _scope_exists(
            scope_type, scope_id, project_id
        ):
            return Response({"error": "Invalid scope"}, status=status.HTTP_400_BAD_REQUEST)
        return None

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, scope_type, scope_id):
        error = self._validate_scope(scope_type, scope_id, project_id)
        if error:
            return error
        layout = ResearchGraphLayout.objects.filter(
            workspace__slug=slug, project_id=project_id, scope_type=scope_type, scope_id=scope_id
        ).first()
        return Response(
            {
                "scope_type": scope_type,
                "scope_id": str(scope_id),
                "nodes": layout.nodes if layout else {},
                "updated_at": layout.updated_at if layout else None,
            },
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def put(self, request, slug, project_id, scope_type, scope_id):
        error = self._validate_scope(scope_type, scope_id, project_id)
        if error:
            return error
        serializer = ResearchGraphLayoutSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        layout, _ = ResearchGraphLayout.objects.update_or_create(
            project_id=project_id,
            scope_type=scope_type,
            scope_id=scope_id,
            defaults={"nodes": serializer.validated_data["nodes"]},
        )
        return Response(
            {
                "scope_type": scope_type,
                "scope_id": str(scope_id),
                "nodes": layout.nodes,
                "updated_at": layout.updated_at,
            },
            status=status.HTTP_200_OK,
        )


class ResearchMatrixEndpoint(BaseAPIView):
    """
    Analysis of Competing Hypotheses matrix of a question: its hypotheses, the
    evidence for and against them, a ranking by inconsistency and which
    evidence actually tells the hypotheses apart.
    """

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST])
    def get(self, request, slug, project_id, issue_id):
        visible = _visible_issues(request, slug, project_id)
        question = visible.filter(pk=issue_id, research_type=QUESTION).first()
        if question is None:
            return Response({"error": "Question not found"}, status=status.HTTP_404_NOT_FOUND)

        lite_fields = ("id", "name", "sequence_id", "research_status", "needs_review")
        hypotheses = list(
            visible.filter(
                research_type=HYPOTHESIS,
                issue_relation__related_issue_id=question.id,
                issue_relation__relation_type="addresses",
                issue_relation__deleted_at__isnull=True,
            )
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

        return Response(
            {
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
            },
            status=status.HTTP_200_OK,
        )
