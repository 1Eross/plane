# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for research graph relations on the public v1 API."""

import pytest
from rest_framework import status

from plane.db.models import Issue, IssueRelation, Project, ProjectMember

RELATIONS_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/work-items/{issue_id}/relations/"
WORK_ITEM_URL = "/api/v1/workspaces/{slug}/projects/{project_id}/work-items/{issue_id}/"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Research", identifier="RND", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def make_node(project, workspace, create_user):
    def _make(research_type, research_status=None):
        issue = Issue(
            name=f"{research_type or 'task'} node",
            project=project,
            workspace=workspace,
            research_type=research_type,
            research_status=research_status,
        )
        issue.save(created_by_id=create_user.id)
        return issue

    return _make


@pytest.fixture
def relations_url(workspace, project):
    return lambda issue: RELATIONS_URL.format(slug=workspace.slug, project_id=project.id, issue_id=issue.id)


@pytest.mark.contract
class TestResearchRelationsPublicAPI:
    @pytest.mark.django_db
    def test_create_research_relation_with_weight(self, api_key_client, relations_url, make_node):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        response = api_key_client.post(
            relations_url(hypothesis),
            {"relation_type": "opposed_by", "issues": [str(evidence.id)], "weight": 2},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED, response.data
        relation = IssueRelation.objects.get(issue=evidence, related_issue=hypothesis)
        assert relation.relation_type == "opposes"
        assert relation.weight == 2

        response = api_key_client.get(relations_url(hypothesis))
        assert response.status_code == status.HTTP_200_OK
        assert response.data["opposed_by"] == [
            {"project_id": str(evidence.project_id), "issue_id": str(evidence.id), "weight": 2}
        ]
        assert response.data["blocking"] == []

    @pytest.mark.django_db
    def test_grammar_enforced(self, api_key_client, relations_url, make_node):
        question = make_node("question", "open")
        experiment = make_node("experiment")
        response = api_key_client.post(
            relations_url(question), {"relation_type": "tests", "issues": [str(experiment.id)]}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert not IssueRelation.objects.exists()

    @pytest.mark.django_db
    def test_unknown_relation_type_rejected(self, api_key_client, relations_url, make_node):
        a, b = make_node(None), make_node(None)
        response = api_key_client.post(
            relations_url(a), {"relation_type": "parent_of", "issues": [str(b.id)]}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_legacy_blocking_still_works(self, api_key_client, relations_url, make_node):
        a, b = make_node(None), make_node(None)
        response = api_key_client.post(
            relations_url(a), {"relation_type": "blocking", "issues": [str(b.id)]}, format="json"
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert IssueRelation.objects.get(issue=b, related_issue=a).relation_type == "blocked_by"
        assert api_key_client.get(relations_url(a)).data["blocking"] == [
            {"project_id": str(b.project_id), "issue_id": str(b.id)}
        ]

    @pytest.mark.django_db
    def test_verdict_rule_on_work_item_update(self, api_key_client, workspace, project, make_node):
        hypothesis = make_node("hypothesis", "testing")
        url = WORK_ITEM_URL.format(slug=workspace.slug, project_id=project.id, issue_id=hypothesis.id)
        response = api_key_client.patch(url, {"research_status": "rejected"}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        hypothesis.refresh_from_db()
        assert hypothesis.research_status == "testing"
