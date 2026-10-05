# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json

# Django imports
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.db.models import Q, OuterRef, F, Func, UUIDField, Value, Subquery
from django.core.serializers.json import DjangoJSONEncoder
from django.db.models.functions import Coalesce
from django.contrib.postgres.aggregates import ArrayAgg
from django.contrib.postgres.fields import ArrayField

# Third Party imports
from rest_framework.response import Response
from rest_framework import status

# Module imports
from .. import BaseViewSet
from plane.app.serializers import IssueRelationSerializer, RelatedIssueSerializer
from plane.app.permissions import ProjectEntityPermission
from plane.db.models import (
    Project,
    IssueRelation,
    Issue,
    FileAsset,
    IssueLink,
    CycleIssue,
)
from plane.bgtasks.issue_activities_task import issue_activity
from plane.utils.issue_relation_mapper import (
    get_actual_relation,
    get_all_relation_types,
    get_inverse_relation,
    is_reverse_relation,
)
from plane.utils.research_grammar import (
    WEIGHTED_RELATIONS,
    ResearchRuleError,
    apply_relation_side_effects,
    prepare_relation_pairs,
)
from plane.utils.host import base_host


class IssueRelationViewSet(BaseViewSet):
    serializer_class = IssueRelationSerializer
    model = IssueRelation
    permission_classes = [ProjectEntityPermission]

    def list(self, request, slug, project_id, issue_id):
        relations = (
            IssueRelation.objects.filter(Q(issue_id=issue_id) | Q(related_issue_id=issue_id))
            .filter(workspace__slug=self.kwargs.get("slug"))
            .order_by("-created_at")
            .values("issue_id", "related_issue_id", "relation_type", "weight")
        )

        # Group related issue ids by the relation name seen from this issue:
        # "A blocked_by B" is "blocked_by" for A and "blocking" for B
        grouped = {relation_name: [] for relation_name in get_all_relation_types()}
        seen = {relation_name: set() for relation_name in grouped}
        for relation in relations:
            if str(relation["issue_id"]) == str(issue_id):
                relation_name = relation["relation_type"]
                other_issue_id = relation["related_issue_id"]
            else:
                relation_name = get_inverse_relation(relation["relation_type"])
                other_issue_id = relation["issue_id"]
            if relation_name not in grouped or other_issue_id in seen[relation_name]:
                continue
            seen[relation_name].add(other_issue_id)
            grouped[relation_name].append((other_issue_id, relation["weight"]))

        related_issue_ids = {other_issue_id for items in grouped.values() for other_issue_id, _ in items}

        queryset = (
            Issue.issue_objects.filter(workspace__slug=slug)
            .select_related("workspace", "project", "state", "parent")
            .prefetch_related("assignees", "labels", "issue_module__module")
            .annotate(
                cycle_id=Subquery(
                    CycleIssue.objects.filter(issue=OuterRef("id"), deleted_at__isnull=True).values("cycle_id")[:1]
                )
            )
            .annotate(
                link_count=IssueLink.objects.filter(issue=OuterRef("id"))
                .order_by()
                .annotate(count=Func(F("id"), function="Count"))
                .values("count")
            )
            .annotate(
                attachment_count=FileAsset.objects.filter(
                    issue_id=OuterRef("id"),
                    entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                )
                .order_by()
                .annotate(count=Func(F("id"), function="Count"))
                .values("count")
            )
            .annotate(
                sub_issues_count=Issue.issue_objects.filter(parent=OuterRef("id"))
                .order_by()
                .annotate(count=Func(F("id"), function="Count"))
                .values("count")
            )
            .annotate(
                label_ids=Coalesce(
                    ArrayAgg(
                        "labels__id",
                        distinct=True,
                        filter=Q(~Q(labels__id__isnull=True) & (Q(label_issue__deleted_at__isnull=True))),
                    ),
                    Value([], output_field=ArrayField(UUIDField())),
                ),
                assignee_ids=Coalesce(
                    ArrayAgg(
                        "assignees__id",
                        distinct=True,
                        filter=Q(
                            ~Q(assignees__id__isnull=True)
                            & Q(assignees__member_project__is_active=True)
                            & Q(issue_assignee__deleted_at__isnull=True)
                        ),
                    ),
                    Value([], output_field=ArrayField(UUIDField())),
                ),
            )
        ).distinct()

        # Fields
        fields = [
            "id",
            "name",
            "state_id",
            "sort_order",
            "priority",
            "sequence_id",
            "project_id",
            "label_ids",
            "assignee_ids",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
            "research_type",
            "research_status",
            "needs_review",
        ]

        issues = {str(issue["id"]): issue for issue in queryset.filter(pk__in=related_issue_ids).values(*fields)}

        response_data = {
            relation_name: [
                {**issues[str(other_issue_id)], "relation_type": relation_name, "weight": weight}
                for other_issue_id, weight in items
                if str(other_issue_id) in issues
            ]
            for relation_name, items in grouped.items()
        }

        return Response(response_data, status=status.HTTP_200_OK)

    def create(self, request, slug, project_id, issue_id):
        relation_type = request.data.get("relation_type", None)
        if relation_type is None:
            return Response(
                {"message": "Issue relation type is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if relation_type not in get_all_relation_types():
            return Response(
                {"message": "Issue relation type is not valid"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        issues = request.data.get("issues", [])
        weight = request.data.get("weight", None)
        project = Project.objects.get(pk=project_id)

        # Scope to workspace to prevent cross-tenant IDOR
        # Relations can cross projects so only workspace scope is enforced
        issues = list(
            Issue.issue_objects.filter(
                workspace__slug=slug,
                pk__in=issues,
            ).values_list("id", flat=True)
        )

        try:
            actual_relation, pairs, is_research = prepare_relation_pairs(
                issue_id, relation_type, issues, slug, weight=weight
            )
        except ResearchRuleError as e:
            return Response({"error": e.message}, status=e.status_code)

        relations_to_create = [
            IssueRelation(
                issue_id=pair_issue_id,
                related_issue_id=pair_related_issue_id,
                relation_type=actual_relation,
                weight=weight if is_research else None,
                project_id=project_id,
                workspace_id=project.workspace_id,
                created_by=request.user,
                updated_by=request.user,
            )
            for pair_issue_id, pair_related_issue_id in pairs
        ]

        if is_research:
            # Research relations are validated above; a conflict here is a concurrent duplicate
            try:
                with transaction.atomic():
                    issue_relation = IssueRelation.objects.bulk_create(relations_to_create, batch_size=10)
            except IntegrityError:
                return Response(
                    {"error": "These work items are already related"},
                    status=status.HTTP_409_CONFLICT,
                )
        else:
            issue_relation = IssueRelation.objects.bulk_create(
                relations_to_create,
                batch_size=10,
                ignore_conflicts=True,
            )

        issue_activity.delay(
            type="issue_relation.activity.created",
            requested_data=json.dumps(request.data, cls=DjangoJSONEncoder),
            actor_id=str(request.user.id),
            issue_id=str(issue_id),
            project_id=str(project_id),
            current_instance=None,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            origin=base_host(request=request, is_app=True),
        )

        if is_research:
            for pair_issue_id, pair_related_issue_id in pairs:
                apply_relation_side_effects(actual_relation, pair_issue_id, pair_related_issue_id)

        if is_reverse_relation(relation_type):
            return Response(
                RelatedIssueSerializer(issue_relation, many=True).data,
                status=status.HTTP_201_CREATED,
            )
        else:
            return Response(
                IssueRelationSerializer(issue_relation, many=True).data,
                status=status.HTTP_201_CREATED,
            )

    def partial_update(self, request, slug, project_id, issue_id, related_issue_id):
        # Only the evidence weight and supports <-> opposes can change in place
        relation = (
            IssueRelation.objects.filter(workspace__slug=slug)
            .filter(
                Q(issue_id=issue_id, related_issue_id=related_issue_id)
                | Q(issue_id=related_issue_id, related_issue_id=issue_id)
            )
            .first()
        )
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
                {"error": "Relation type can only change between supports and opposes"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if weight not in (1, 2, 3):
            return Response({"error": "Weight must be 1, 2 or 3"}, status=status.HTTP_400_BAD_REQUEST)

        previous_relation_type = relation.relation_type
        relation.relation_type = new_relation_type
        relation.weight = weight
        relation.save(update_fields=["relation_type", "weight", "updated_at", "updated_by"])

        if previous_relation_type != new_relation_type:
            # Relation names as seen from issue_id, which is what the activity log expects
            if str(relation.issue_id) == str(issue_id):
                previous_name, new_name = previous_relation_type, new_relation_type
            else:
                previous_name = get_inverse_relation(previous_relation_type)
                new_name = get_inverse_relation(new_relation_type)
            epoch = int(timezone.now().timestamp())
            issue_activity.delay(
                type="issue_relation.activity.deleted",
                requested_data=json.dumps(
                    {"related_issue": str(related_issue_id), "relation_type": previous_name},
                    cls=DjangoJSONEncoder,
                ),
                actor_id=str(request.user.id),
                issue_id=str(issue_id),
                project_id=str(project_id),
                current_instance=None,
                epoch=epoch,
                notification=True,
                origin=base_host(request=request, is_app=True),
            )
            issue_activity.delay(
                type="issue_relation.activity.created",
                requested_data=json.dumps(
                    {"issues": [str(related_issue_id)], "relation_type": new_name},
                    cls=DjangoJSONEncoder,
                ),
                actor_id=str(request.user.id),
                issue_id=str(issue_id),
                project_id=str(project_id),
                current_instance=None,
                epoch=epoch,
                notification=True,
                origin=base_host(request=request, is_app=True),
            )

        apply_relation_side_effects(new_relation_type, relation.issue_id, relation.related_issue_id)

        if str(relation.issue_id) == str(issue_id):
            return Response(IssueRelationSerializer(relation).data, status=status.HTTP_200_OK)
        return Response(RelatedIssueSerializer(relation).data, status=status.HTTP_200_OK)

    def remove_relation(self, request, slug, project_id, issue_id):
        related_issue = request.data.get("related_issue", None)

        issue_relations = IssueRelation.objects.filter(
            workspace__slug=slug,
        ).filter(
            Q(issue_id=related_issue, related_issue_id=issue_id) | Q(issue_id=issue_id, related_issue_id=related_issue)
        )
        relation_type = request.data.get("relation_type", None)
        if relation_type:
            issue_relations = issue_relations.filter(relation_type=get_actual_relation(relation_type))
        issue_relations = issue_relations.first()
        if issue_relations is None:
            return Response({"error": "Relation not found"}, status=status.HTTP_404_NOT_FOUND)
        current_instance = json.dumps(IssueRelationSerializer(issue_relations).data, cls=DjangoJSONEncoder)
        removed_relation = (
            issue_relations.relation_type,
            issue_relations.issue_id,
            issue_relations.related_issue_id,
        )
        issue_relations.delete()
        apply_relation_side_effects(*removed_relation)
        issue_activity.delay(
            type="issue_relation.activity.deleted",
            requested_data=json.dumps(request.data, cls=DjangoJSONEncoder),
            actor_id=str(request.user.id),
            issue_id=str(issue_id),
            project_id=str(project_id),
            current_instance=current_instance,
            epoch=int(timezone.now().timestamp()),
            notification=True,
            origin=base_host(request=request, is_app=True),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
