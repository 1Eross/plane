# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

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
from plane.db.models import Issue, IssueResearchDetails, ResearchGraphLayout
from plane.utils.filters import ComplexFilterBackend, IssueFilterSet
from plane.utils.grouper import issue_queryset_grouper
from plane.utils.host import base_host
from plane.utils.issue_filters import issue_filters
from plane.utils.research_grammar import QUESTION, ResearchRuleError
from plane.utils.research_service import (
    build_matrix,
    collect_graph,
    filter_by_scope,
    merge_hypotheses,
    scope_exists,
    visible_issues,
)
from plane.utils.timezone_converter import user_timezone_converter

from .. import BaseAPIView
from .base import IssueViewSet

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


def _visible_issues(request, slug, project_id):
    return visible_issues(request.user, slug, project_id)


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
        try:
            merged, question_ids = merge_hypotheses(
                request.user,
                _visible_issues(request, slug, project_id),
                project_id,
                hypothesis_ids,
                serializer.validated_data["name"],
                origin=base_host(request=request, is_app=True),
            )
        except ResearchRuleError as e:
            return Response({"error": e.message}, status=e.status_code)

        return Response(
            {
                "issue": _serialize_nodes(Issue.issue_objects.filter(pk=merged.id), request)[0],
                "derived_from": [str(hypothesis_id) for hypothesis_id in hypothesis_ids],
                "addresses": [str(question_id) for question_id in question_ids],
            },
            status=status.HTTP_201_CREATED,
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
        if scope_type not in ResearchGraphLayout.ScopeType.values or not scope_exists(scope_type, scope_id, project_id):
            return Response({"error": "Invalid scope"}, status=status.HTTP_400_BAD_REQUEST)

        visible = _visible_issues(request, slug, project_id).filter(research_type__isnull=False)
        # A project view sends its own filters with the request, like the issue list does
        queryset = filter_by_scope(visible, scope_type, scope_id)
        queryset = self.filter_queryset(queryset)
        queryset = queryset.filter(**issue_filters(request.query_params, "GET"))

        node_ids, ghost_ids, edges, truncated = collect_graph(visible, queryset)
        all_ids = node_ids | ghost_ids
        nodes = _serialize_nodes(Issue.issue_objects.filter(pk__in=all_ids), request) if all_ids else []
        for node in nodes:
            node["is_ghost"] = node["id"] in ghost_ids

        return Response({"nodes": nodes, "edges": edges, "truncated": truncated}, status=status.HTTP_200_OK)


class ResearchGraphLayoutEndpoint(BaseAPIView):
    """Shared node positions and collapsed branches of one research graph scope."""

    def _validate_scope(self, scope_type, scope_id, project_id):
        if scope_type not in ResearchGraphLayout.ScopeType.values or not scope_exists(scope_type, scope_id, project_id):
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

        return Response(build_matrix(visible, question), status=status.HTTP_200_OK)
