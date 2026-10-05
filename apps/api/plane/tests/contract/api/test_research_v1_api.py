# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the research graph in the public v1 API (API key auth)."""

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import APIToken, Issue, IssueRelation, Project, ProjectMember, User, WorkspaceMember

BASE = "/api/v1/workspaces/{slug}/projects/{project_id}"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Research", identifier="RND", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def base_url(workspace, project):
    return BASE.format(slug=workspace.slug, project_id=project.id)


@pytest.fixture
def guest_api_client(db, workspace, project):
    guest = User.objects.create(email="guest@plane.so", username="research-guest", first_name="Guest")
    WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
    ProjectMember.objects.create(project=project, member=guest, workspace=workspace, role=5)
    token = APIToken.objects.create(user=guest, label="guest", token="guest-api-token-12345")
    client = APIClient()
    client.credentials(HTTP_X_API_KEY=token.token)
    return client


def _create(client, base_url, name, research_type, **extra):
    response = client.post(
        f"{base_url}/work-items/", {"name": name, "research_type": research_type, **extra}, format="json"
    )
    assert response.status_code == status.HTTP_201_CREATED, response.data
    return str(response.data["id"])


def _relate(client, base_url, issue_id, relation_type, related_ids, **extra):
    return client.post(
        f"{base_url}/work-items/{issue_id}/relations/",
        {"relation_type": relation_type, "issues": [str(related) for related in related_ids], **extra},
        format="json",
    )


@pytest.mark.contract
class TestResearchV1:
    @pytest.mark.django_db
    def test_build_a_graph_through_v1(self, api_key_client, base_url):
        question = _create(api_key_client, base_url, "Why is p95 high?", "question")
        h1 = _create(api_key_client, base_url, "Cold cache", "hypothesis")
        h2 = _create(api_key_client, base_url, "N+1 queries", "hypothesis")
        experiment = _create(api_key_client, base_url, "Warm the cache", "experiment")
        evidence = _create(api_key_client, base_url, "p95 unchanged", "evidence")
        assert Issue.objects.get(pk=question).research_status == "open"
        assert Issue.objects.get(pk=evidence).research_status == "valid"

        assert _relate(api_key_client, base_url, question, "addressed_by", [h1, h2]).status_code == 201
        assert _relate(api_key_client, base_url, experiment, "tests", [h1]).status_code == 201
        assert _relate(api_key_client, base_url, experiment, "produces", [evidence]).status_code == 201
        assert _relate(api_key_client, base_url, evidence, "opposes", [h1], weight=3).status_code == 201
        # grammar is enforced
        assert _relate(api_key_client, base_url, question, "tests", [h2]).status_code == 400

        response = api_key_client.get(f"{base_url}/research-graph/")
        assert response.status_code == status.HTTP_200_OK, response.data
        assert response.data["project_identifier"] == "RND"
        assert {str(node["id"]) for node in response.data["nodes"]} == {question, h1, h2, experiment, evidence}
        assert len(response.data["edges"]) == 5

        # filter + ghosts: only hypotheses match, their neighbours come back as ghosts
        response = api_key_client.get(f"{base_url}/research-graph/", {"research_type": "hypothesis"})
        ghosts = {str(node["id"]) for node in response.data["nodes"] if node["is_ghost"]}
        assert ghosts == {question, experiment, evidence}

    @pytest.mark.django_db
    def test_verdicts_follow_the_rules(self, api_key_client, base_url):
        question = _create(api_key_client, base_url, "Q", "question")
        hypothesis = _create(api_key_client, base_url, "H", "hypothesis")
        evidence = _create(api_key_client, base_url, "R", "evidence")
        _relate(api_key_client, base_url, hypothesis, "addresses", [question])

        url = f"{base_url}/work-items/{hypothesis}/"
        assert api_key_client.patch(url, {"research_status": "confirmed"}, format="json").status_code == 400

        _relate(api_key_client, base_url, evidence, "supports", [hypothesis], weight=2)
        assert api_key_client.patch(url, {"research_status": "confirmed"}, format="json").status_code == 200
        assert Issue.objects.get(pk=question).research_status == "answered"

        # deleting the only support flags the verdict for review
        response = api_key_client.delete(
            f"{base_url}/work-items/{hypothesis}/relations/{evidence}/", {"relation_type": "supported_by"}
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert Issue.objects.get(pk=hypothesis).needs_review is True

    @pytest.mark.django_db
    def test_patch_relation(self, api_key_client, base_url):
        hypothesis = _create(api_key_client, base_url, "H", "hypothesis")
        evidence = _create(api_key_client, base_url, "R", "evidence")
        _relate(api_key_client, base_url, evidence, "supports", [hypothesis], weight=1)

        url = f"{base_url}/work-items/{hypothesis}/relations/{evidence}/"
        response = api_key_client.patch(url, {"relation_type": "opposed_by", "weight": 3}, format="json")
        assert response.status_code == status.HTTP_200_OK, response.data
        relation = IssueRelation.objects.get(issue_id=evidence, related_issue_id=hypothesis)
        assert (relation.relation_type, relation.weight) == ("opposes", 3)
        assert api_key_client.patch(url, {"weight": 9}, format="json").status_code == 400

    @pytest.mark.django_db
    def test_details(self, api_key_client, base_url):
        evidence = _create(api_key_client, base_url, "R", "evidence")
        url = f"{base_url}/work-items/{evidence}/research/"
        response = api_key_client.patch(
            url,
            {"statement": "p95 stays at 430 ms", "commit_sha": "a1b2c3d", "branch": "exp/rnd-4-warmup"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK, response.data
        response = api_key_client.get(url)
        assert response.data["commit_sha"] == "a1b2c3d"
        assert response.data["research_type"] == "evidence"

        task = Issue.objects.create(name="plain", project_id=Issue.objects.get(pk=evidence).project_id)
        assert (
            api_key_client.patch(
                f"{base_url}/work-items/{task.id}/research/", {"statement": "x"}, format="json"
            ).status_code
            == 400
        )

    @pytest.mark.django_db
    def test_merge_and_matrix(self, api_key_client, base_url):
        question = _create(api_key_client, base_url, "Q", "question")
        h1 = _create(api_key_client, base_url, "H1", "hypothesis")
        h2 = _create(api_key_client, base_url, "H2", "hypothesis")
        evidence = _create(api_key_client, base_url, "R", "evidence")
        _relate(api_key_client, base_url, question, "addressed_by", [h1, h2])
        _relate(api_key_client, base_url, evidence, "opposes", [h1], weight=3)

        response = api_key_client.get(f"{base_url}/work-items/{question}/research-matrix/")
        assert response.status_code == status.HTTP_200_OK
        assert [str(item["id"]) for item in response.data["hypotheses"]] == [h2, h1]

        response = api_key_client.post(
            f"{base_url}/research/merge/", {"hypothesis_ids": [h1, h2], "name": "Merged"}, format="json"
        )
        assert response.status_code == status.HTTP_201_CREATED, response.data
        assert response.data["addresses"] == [question]
        assert set(Issue.objects.filter(pk__in=[h1, h2]).values_list("research_status", flat=True)) == {"superseded"}

    @pytest.mark.django_db
    def test_guest_reads_only(self, api_key_client, guest_api_client, base_url, project):
        project.guest_view_all_features = True
        project.save()
        question = _create(api_key_client, base_url, "Q", "question")
        assert guest_api_client.get(f"{base_url}/research-graph/").status_code == status.HTTP_200_OK
        assert guest_api_client.get(f"{base_url}/work-items/{question}/research/").status_code == status.HTTP_200_OK
        assert (
            guest_api_client.patch(
                f"{base_url}/work-items/{question}/research/", {"statement": "x"}, format="json"
            ).status_code
            == status.HTTP_403_FORBIDDEN
        )
        assert (
            guest_api_client.post(
                f"{base_url}/research/merge/", {"hypothesis_ids": [question, question], "name": "x"}, format="json"
            ).status_code
            == status.HTTP_403_FORBIDDEN
        )
