# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""
Research graph in the public v1 API (API key auth), so agents and scripts can
read and grow a research graph: node details, the graph itself, merging
hypotheses, the competing hypotheses matrix and editing single relations.
Research nodes are created and their type / status changed through the
regular work item endpoints; relations through work-items/<id>/relations/.
"""

# Python imports
import json

# Django imports
from django.core.serializers.json import DjangoJSONEncoder
from django.db.models import Q
from django.utils import timezone

# Third Party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ProjectEntityPermission
from plane.app.serializers.research import IssueResearchDetailsSerializer, ResearchMergeSerializer
from plane.bgtasks.issue_activities_task import issue_activity
from plane.db.models import Issue, IssueRelation, IssueResearchDetails, Project, ResearchGraphLayout
from plane.utils.host import base_host
from plane.utils.issue_relation_mapper import get_actual_relation, get_inverse_relation
from plane.utils.research_grammar import (
    QUESTION,
    RESEARCH_RELATIONS,
    WEIGHTED_RELATIONS,
    ResearchRuleError,
    apply_relation_side_effects,
)
from plane.utils.research_service import (
    build_matrix,
    collect_graph,
    filter_by_scope,
    merge_hypotheses,
    scope_exists,
    visible_issues,
)

from .base import BaseAPIView

NODE_FIELDS = (
    "id",
    "sequence_id",
    "name",
    "research_type",
    "research_status",
    "needs_review",
    "state_id",
    "parent_id",
    "project_id",
    "created_at",
    "updated_at",
)


def _details_response(issue, details):
    data = IssueResearchDetailsSerializer(details).data if details else {"issue_id": issue.id}
    data.update(
        {
            "research_type": issue.research_type,
            "research_status": issue.research_status,
            "needs_review": issue.needs_review,
        }
    )
    return data


class WorkItemResearchAPIEndpoint(BaseAPIView):
    """Research details of a work item: statement, criteria, conclusion, confidence, reproducibility."""

    permission_classes = [ProjectEntityPermission]

    def get(self, request, slug, project_id, issue_id):
        issue = visible_issues(request.user, slug, project_id).filter(pk=issue_id).first()
        if issue is None:
            return Response({"error": "Work item not found"}, status=status.HTTP_404_NOT_FOUND)
        details = IssueResearchDetails.objects.filter(issue_id=issue.id).first()
        return Response(_details_response(issue, details), status=status.HTTP_200_OK)

    def patch(self, request, slug, project_id, issue_id):
        issue = visible_issues(request.user, slug, project_id).filter(pk=issue_id).first()
        if issue is None:
            return Response({"error": "Work item not found"}, status=status.HTTP_404_NOT_FOUND)
        if issue.research_type is None:
            return Response(
                {"error": "Set a research_type on the work item first"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        details = IssueResearchDetails.objects.filter(issue_id=issue.id).first()
        serializer = IssueResearchDetailsSerializer(details, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        details = serializer.save(issue_id=issue.id, project_id=issue.project_id, workspace_id=issue.workspace_id)
        return Response(_details_response(issue, details), status=status.HTTP_200_OK)


class ResearchGraphAPIEndpoint(BaseAPIView):
    """
    Research nodes of a scope with their edges in one response.
    Query params: scope_type (project|cycle|module), scope_id, research_type (comma separated),
    research_status (comma separated). Research neighbours outside the filters come back as
    ghosts so the graph stays connected.
    """

    permission_classes = [ProjectEntityPermission]

    def get(self, request, slug, project_id):
        scope_type = request.GET.get("scope_type", ResearchGraphLayout.ScopeType.PROJECT)
        scope_id = request.GET.get("scope_id", str(project_id))
        if scope_type == ResearchGraphLayout.ScopeType.VIEW or not scope_exists(scope_type, scope_id, project_id):
            return Response(
                {"error": "scope_type must be project, cycle or module of this project"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        visible = visible_issues(request.user, slug, project_id).filter(research_type__isnull=False)
        queryset = filter_by_scope(visible, scope_type, scope_id)
        for field in ("research_type", "research_status"):
            values = [value for value in request.GET.get(field, "").split(",") if value]
            if values:
                queryset = queryset.filter(**{f"{field}__in": values})

        node_ids, ghost_ids, edges, truncated = collect_graph(visible, queryset)
        nodes = list(Issue.issue_objects.filter(pk__in=node_ids | ghost_ids).values(*NODE_FIELDS))
        for node in nodes:
            node["is_ghost"] = node["id"] in ghost_ids

        project = Project.objects.get(pk=project_id)
        return Response(
            {
                "project_identifier": project.identifier,
                "nodes": nodes,
                "edges": edges,
                "truncated": truncated,
            },
            status=status.HTTP_200_OK,
        )


class ResearchMergeAPIEndpoint(BaseAPIView):
    """Merge hypotheses into a new hypothesis derived from all of them; the sources become superseded."""

    permission_classes = [ProjectEntityPermission]

    def post(self, request, slug, project_id):
        serializer = ResearchMergeSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        hypothesis_ids = serializer.validated_data["hypothesis_ids"]
        try:
            merged, question_ids = merge_hypotheses(
                request.user,
                visible_issues(request.user, slug, project_id),
                project_id,
                hypothesis_ids,
                serializer.validated_data["name"],
                origin=base_host(request=request, is_app=False),
            )
        except ResearchRuleError as e:
            return Response({"error": e.message}, status=e.status_code)
        return Response(
            {
                "issue": Issue.issue_objects.filter(pk=merged.id).values(*NODE_FIELDS).first(),
                "derived_from": [str(hypothesis_id) for hypothesis_id in hypothesis_ids],
                "addresses": [str(question_id) for question_id in question_ids],
            },
            status=status.HTTP_201_CREATED,
        )


class ResearchMatrixAPIEndpoint(BaseAPIView):
    """Analysis of Competing Hypotheses matrix of a question."""

    permission_classes = [ProjectEntityPermission]

    def get(self, request, slug, project_id, issue_id):
        visible = visible_issues(request.user, slug, project_id)
        question = visible.filter(pk=issue_id, research_type=QUESTION).first()
        if question is None:
            return Response({"error": "Question not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(build_matrix(visible, question), status=status.HTTP_200_OK)


class WorkItemRelationDetailAPIEndpoint(BaseAPIView):
    """
    One relation between two work items, in either direction.
    PATCH changes the weight of a supports / opposes relation or switches between the two;
    DELETE removes the relation (optionally only of ?relation_type=...).
    """

    permission_classes = [ProjectEntityPermission]

    def _relations(self, slug, issue_id, related_issue_id):
        return IssueRelation.objects.filter(workspace__slug=slug).filter(
            Q(issue_id=issue_id, related_issue_id=related_issue_id)
            | Q(issue_id=related_issue_id, related_issue_id=issue_id)
        )

    def _log(self, request, project_id, issue_id, activity_type, payload):
        issue_activity.delay(
            type=activity_type,
            requested_data=json.dumps(payload, cls=DjangoJSONEncoder),
            actor_id=str(request.user.id),
            issue_id=str(issue_id),
            project_id=str(project_id),
            current_instance=None,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            origin=base_host(request=request, is_app=False),
        )

    @staticmethod
    def _name_from(relation, issue_id, relation_type):
        # relation names are read from the issue in the URL: "blocked_by" for one end, "blocking" for the other
        return relation_type if str(relation.issue_id) == str(issue_id) else get_inverse_relation(relation_type)

    def patch(self, request, slug, project_id, issue_id, related_issue_id):
        relation = self._relations(slug, issue_id, related_issue_id).first()
        if relation is None:
            return Response({"error": "Relation not found"}, status=status.HTTP_404_NOT_FOUND)
        if relation.relation_type not in WEIGHTED_RELATIONS:
            return Response(
                {"error": "Only supports / opposes relations can be updated"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        new_relation_type = get_actual_relation(request.data.get("relation_type", relation.relation_type))
        weight = request.data.get("weight", relation.weight)
        if new_relation_type not in WEIGHTED_RELATIONS:
            return Response(
                {"error": "relation_type can only change between supports and opposes"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if weight not in (1, 2, 3):
            return Response({"error": "weight must be 1, 2 or 3"}, status=status.HTTP_400_BAD_REQUEST)

        previous_relation_type = relation.relation_type
        relation.relation_type = new_relation_type
        relation.weight = weight
        relation.save(update_fields=["relation_type", "weight", "updated_at", "updated_by"])
        if previous_relation_type != new_relation_type:
            self._log(
                request,
                project_id,
                issue_id,
                "issue_relation.activity.deleted",
                {
                    "related_issue": str(related_issue_id),
                    "relation_type": self._name_from(relation, issue_id, previous_relation_type),
                },
            )
            self._log(
                request,
                project_id,
                issue_id,
                "issue_relation.activity.created",
                {
                    "issues": [str(related_issue_id)],
                    "relation_type": self._name_from(relation, issue_id, new_relation_type),
                },
            )
        apply_relation_side_effects(new_relation_type, relation.issue_id, relation.related_issue_id)
        return Response(
            {
                "issue_id": str(relation.issue_id),
                "related_issue_id": str(relation.related_issue_id),
                "relation_type": relation.relation_type,
                "weight": relation.weight,
            },
            status=status.HTTP_200_OK,
        )

    def delete(self, request, slug, project_id, issue_id, related_issue_id):
        relations = self._relations(slug, issue_id, related_issue_id)
        relation_type = request.GET.get("relation_type")
        if relation_type:
            relations = relations.filter(relation_type=get_actual_relation(relation_type))
        relation = relations.first()
        if relation is None:
            return Response({"error": "Relation not found"}, status=status.HTTP_404_NOT_FOUND)
        removed = (relation.relation_type, relation.issue_id, relation.related_issue_id)
        relation.delete()
        self._log(
            request,
            project_id,
            issue_id,
            "issue_relation.activity.deleted",
            {"related_issue": str(related_issue_id), "relation_type": self._name_from(relation, issue_id, removed[0])},
        )
        if removed[0] in RESEARCH_RELATIONS:
            apply_relation_side_effects(*removed)
        return Response(status=status.HTTP_204_NO_CONTENT)
