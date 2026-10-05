# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for the research graph endpoints: details, merge, graph, layout, matrix."""

import json

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    Cycle,
    CycleIssue,
    Issue,
    IssueRelation,
    IssueResearchDetails,
    Project,
    ProjectMember,
    ResearchGraphLayout,
    State,
    User,
    WorkspaceMember,
)

BASE = "/api/workspaces/{slug}/projects/{project_id}"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Research", identifier="RND", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def base_url(workspace, project):
    return BASE.format(slug=workspace.slug, project_id=project.id)


@pytest.fixture
def make_node(project, workspace, create_user):
    def _make(research_type, research_status=None, name=None, author=None):
        issue = Issue(
            name=name or f"{research_type or 'task'} node",
            project=project,
            workspace=workspace,
            research_type=research_type,
            research_status=research_status,
        )
        issue.save(created_by_id=(author or create_user).id)
        return issue

    return _make


@pytest.fixture
def link(project, workspace):
    def _link(source, target, relation_type, weight=None):
        return IssueRelation.objects.create(
            issue=source,
            related_issue=target,
            relation_type=relation_type,
            weight=weight,
            project=project,
            workspace=workspace,
        )

    return _link


@pytest.fixture
def guest_client(db, workspace, project):
    guest = User.objects.create(email="guest@plane.so", username="research-guest", first_name="Guest", last_name="User")
    WorkspaceMember.objects.create(workspace=workspace, member=guest, role=5)
    ProjectMember.objects.create(project=project, member=guest, workspace=workspace, role=5)
    client = APIClient()
    client.force_authenticate(user=guest)
    client.user = guest
    return client


@pytest.mark.contract
class TestResearchDetails:
    @pytest.mark.django_db
    def test_get_defaults_and_patch(self, session_client, base_url, make_node):
        evidence = make_node("evidence", "valid")
        url = f"{base_url}/issues/{evidence.id}/research/"

        response = session_client.get(url)
        assert response.status_code == status.HTTP_200_OK
        assert response.data["research_type"] == "evidence"
        assert response.data["research_status"] == "valid"

        response = session_client.patch(
            url,
            {
                "statement": "Cache warm-up halves p95",
                "confidence": 70,
                "commit_sha": "a1b2c3d",
                "branch": "exp/rnd-2-cache-warmup",
                "conclusion_html": "<p>ok</p><script>alert(1)</script>",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK, response.data
        details = IssueResearchDetails.objects.get(issue=evidence)
        assert details.statement == "Cache warm-up halves p95"
        assert details.commit_sha == "a1b2c3d"
        assert "<script>" not in details.conclusion_html

    @pytest.mark.django_db
    def test_validation(self, session_client, base_url, make_node):
        evidence = make_node("evidence", "valid")
        url = f"{base_url}/issues/{evidence.id}/research/"
        assert session_client.patch(url, {"commit_sha": "not-a-sha"}, format="json").status_code == 400
        assert session_client.patch(url, {"confidence": 101}, format="json").status_code == 400
        # Verdict fields are read-only
        session_client.patch(url, {"verdict_at": "2026-01-01T00:00:00Z"}, format="json")
        assert IssueResearchDetails.objects.get(issue=evidence).verdict_at is None

    @pytest.mark.django_db
    def test_regular_work_item_rejected(self, session_client, base_url, make_node):
        task = make_node(None)
        response = session_client.patch(f"{base_url}/issues/{task.id}/research/", {"statement": "x"}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_guest_reads_but_cannot_write(self, guest_client, base_url, make_node):
        hypothesis = make_node("hypothesis", "proposed", author=guest_client.user)
        url = f"{base_url}/issues/{hypothesis.id}/research/"
        assert guest_client.get(url).status_code == status.HTTP_200_OK
        assert guest_client.patch(url, {"statement": "x"}, format="json").status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.contract
class TestResearchMerge:
    @pytest.mark.django_db
    def test_merge(self, session_client, base_url, make_node, link):
        q1, q2 = make_node("question", "open"), make_node("question", "open")
        h1, h2 = make_node("hypothesis", "testing"), make_node("hypothesis", "proposed")
        link(h1, q1, "addresses")
        link(h2, q2, "addresses")

        response = session_client.post(
            f"{base_url}/research/merge/",
            {"hypothesis_ids": [str(h1.id), str(h2.id)], "name": "Combined"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED, response.data

        merged = Issue.objects.get(pk=response.data["issue"]["id"])
        assert merged.research_type == "hypothesis"
        assert merged.research_status == "proposed"
        assert set(
            IssueRelation.objects.filter(issue=merged, relation_type="derived_from").values_list(
                "related_issue_id", flat=True
            )
        ) == {h1.id, h2.id}
        assert set(
            IssueRelation.objects.filter(issue=merged, relation_type="addresses").values_list(
                "related_issue_id", flat=True
            )
        ) == {q1.id, q2.id}
        assert set(Issue.objects.filter(pk__in=[h1.id, h2.id]).values_list("research_status", flat=True)) == {
            "superseded"
        }

    @pytest.mark.django_db
    def test_merge_hypotheses_of_the_same_question(self, session_client, base_url, make_node, link):
        question = make_node("question", "open")
        h1, h2 = make_node("hypothesis", "testing"), make_node("hypothesis", "proposed")
        link(h1, question, "addresses")
        link(h2, question, "addresses")

        response = session_client.post(
            f"{base_url}/research/merge/",
            {"hypothesis_ids": [str(h1.id), str(h2.id)], "name": "Combined"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED, response.data
        assert response.data["addresses"] == [str(question.id)]
        merged = Issue.objects.get(pk=response.data["issue"]["id"])
        assert IssueRelation.objects.filter(issue=merged, relation_type="addresses").count() == 1

    @pytest.mark.django_db
    def test_merging_confirmed_hypothesis_reopens_question(self, session_client, base_url, make_node, link):
        question = make_node("question", "answered")
        confirmed = make_node("hypothesis", "confirmed")
        other = make_node("hypothesis", "proposed")
        link(confirmed, question, "addresses")
        link(make_node("evidence", "valid"), confirmed, "supports", weight=2)

        response = session_client.post(
            f"{base_url}/research/merge/",
            {"hypothesis_ids": [str(confirmed.id), str(other.id)], "name": "Refined"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        question.refresh_from_db()
        assert question.research_status == "open"

    @pytest.mark.django_db
    def test_merge_validation(self, session_client, base_url, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        question = make_node("question", "open")
        url = f"{base_url}/research/merge/"
        assert (
            session_client.post(url, {"hypothesis_ids": [str(hypothesis.id)], "name": "x"}, format="json").status_code
            == 400
        )
        assert (
            session_client.post(
                url, {"hypothesis_ids": [str(hypothesis.id), str(question.id)], "name": "x"}, format="json"
            ).status_code
            == 400
        )
        assert (
            session_client.post(
                url, {"hypothesis_ids": [str(hypothesis.id), str(hypothesis.id)], "name": "x"}, format="json"
            ).status_code
            == 400
        )
        assert not Issue.objects.filter(name="x").exists()


@pytest.mark.contract
class TestResearchGraph:
    @pytest.mark.django_db
    def test_project_graph(self, session_client, base_url, make_node, link):
        question = make_node("question", "open")
        hypothesis = make_node("hypothesis", "proposed")
        task = make_node(None)
        link(hypothesis, question, "addresses")

        response = session_client.get(f"{base_url}/research-graph/")
        assert response.status_code == status.HTTP_200_OK
        node_ids = {node["id"] for node in response.data["nodes"]}
        assert node_ids == {question.id, hypothesis.id}
        assert task.id not in node_ids
        assert not any(node["is_ghost"] for node in response.data["nodes"])
        assert response.data["truncated"] is False
        [edge] = response.data["edges"]
        assert (edge["source"], edge["target"], edge["relation_type"]) == (hypothesis.id, question.id, "addresses")
        node = next(node for node in response.data["nodes"] if node["id"] == hypothesis.id)
        for field in ["state_id", "label_ids", "assignee_ids", "sub_issues_count", "research_status"]:
            assert field in node

    @pytest.mark.django_db
    def test_filtered_out_neighbours_are_ghosts(self, session_client, base_url, make_node, link):
        question = make_node("question", "open")
        rejected = make_node("hypothesis", "rejected")
        link(rejected, question, "addresses")

        response = session_client.get(
            f"{base_url}/research-graph/", {"filters": json.dumps({"research_status": "rejected"})}
        )
        assert response.status_code == status.HTTP_200_OK, response.data
        nodes = {node["id"]: node for node in response.data["nodes"]}
        assert nodes[rejected.id]["is_ghost"] is False
        assert nodes[question.id]["is_ghost"] is True
        assert len(response.data["edges"]) == 1

    @pytest.mark.django_db
    def test_cycle_scope(self, session_client, base_url, workspace, project, make_node, create_user):
        cycle = Cycle.objects.create(name="Sprint", project=project, workspace=workspace, owned_by=create_user)
        in_cycle = make_node("experiment")
        make_node("experiment")
        CycleIssue.objects.create(cycle=cycle, issue=in_cycle, project=project, workspace=workspace)

        response = session_client.get(f"{base_url}/research-graph/", {"scope_type": "cycle", "scope_id": str(cycle.id)})
        assert response.status_code == status.HTTP_200_OK
        assert [node["id"] for node in response.data["nodes"]] == [in_cycle.id]

    @pytest.mark.django_db
    def test_invalid_scope(self, session_client, base_url, make_node):
        response = session_client.get(
            f"{base_url}/research-graph/", {"scope_type": "cycle", "scope_id": str(make_node(None).id)}
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_restricted_guest_sees_own_nodes_only(self, guest_client, base_url, make_node, link):
        own = make_node("hypothesis", "proposed", author=guest_client.user)
        foreign = make_node("question", "open")
        link(own, foreign, "addresses")

        response = guest_client.get(f"{base_url}/research-graph/")
        assert response.status_code == status.HTTP_200_OK
        assert [node["id"] for node in response.data["nodes"]] == [own.id]
        assert response.data["edges"] == []


@pytest.mark.contract
class TestResearchGraphLayout:
    @pytest.mark.django_db
    def test_put_then_get(self, session_client, base_url, project, make_node):
        node = make_node("question", "open")
        url = f"{base_url}/research-graph/layouts/project/{project.id}/"

        assert session_client.get(url).data["nodes"] == {}
        response = session_client.put(
            url, {"nodes": {str(node.id): {"x": 10, "y": -4.5, "collapsed": True}}}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK, response.data
        assert session_client.get(url).data["nodes"] == {str(node.id): {"x": 10.0, "y": -4.5, "collapsed": True}}

        session_client.put(url, {"nodes": {}}, format="json")
        assert ResearchGraphLayout.objects.count() == 1
        assert session_client.get(url).data["nodes"] == {}

    @pytest.mark.django_db
    def test_scopes_are_isolated_and_validated(self, session_client, base_url, workspace, project, create_user):
        cycle = Cycle.objects.create(name="Sprint", project=project, workspace=workspace, owned_by=create_user)
        project_url = f"{base_url}/research-graph/layouts/project/{project.id}/"
        cycle_url = f"{base_url}/research-graph/layouts/cycle/{cycle.id}/"
        node_id = "6f1c3c3e-6c1a-4c55-9a52-1f2b3c4d5e6f"
        session_client.put(cycle_url, {"nodes": {node_id: {"x": 1, "y": 2}}}, format="json")
        assert session_client.get(project_url).data["nodes"] == {}
        assert session_client.get(cycle_url).data["nodes"] == {node_id: {"x": 1.0, "y": 2.0}}

        assert session_client.get(f"{base_url}/research-graph/layouts/page/{project.id}/").status_code == 400
        assert session_client.get(f"{base_url}/research-graph/layouts/cycle/{project.id}/").status_code == 400

    @pytest.mark.django_db
    def test_payload_validation(self, session_client, base_url, project):
        url = f"{base_url}/research-graph/layouts/project/{project.id}/"
        assert session_client.put(url, {"nodes": {"nope": {"x": 1}}}, format="json").status_code == 400
        node_id = "6f1c3c3e-6c1a-4c55-9a52-1f2b3c4d5e6f"
        assert session_client.put(url, {"nodes": {node_id: {"x": "1"}}}, format="json").status_code == 400
        assert session_client.put(url, {"nodes": {node_id: {"collapsed": "yes"}}}, format="json").status_code == 400

    @pytest.mark.django_db
    def test_guest_cannot_write(self, guest_client, base_url, project):
        url = f"{base_url}/research-graph/layouts/project/{project.id}/"
        assert guest_client.get(url).status_code == status.HTTP_200_OK
        assert guest_client.put(url, {"nodes": {}}, format="json").status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.contract
class TestResearchMatrix:
    @pytest.mark.django_db
    def test_matrix_ranking_and_diagnosticity(self, session_client, base_url, make_node, link):
        question = make_node("question", "open")
        h1, h2 = make_node("hypothesis", "testing", "H1"), make_node("hypothesis", "testing", "H2")
        link(h1, question, "addresses")
        link(h2, question, "addresses")

        against_h1 = make_node("evidence", "valid", "R1")
        link(against_h1, h1, "opposes", weight=3)
        link(against_h1, h2, "supports", weight=1)
        both = make_node("evidence", "valid", "R2")  # rates both the same
        link(both, h1, "supports", weight=2)
        link(both, h2, "supports", weight=2)
        invalidated = make_node("evidence", "invalidated", "R3")
        link(invalidated, h2, "opposes", weight=3)

        response = session_client.get(f"{base_url}/issues/{question.id}/research-matrix/")
        assert response.status_code == status.HTTP_200_OK, response.data

        ranked = response.data["hypotheses"]
        assert [item["id"] for item in ranked] == [h2.id, h1.id]
        assert ranked[0]["inconsistency"] == 0  # invalidated evidence does not count
        assert ranked[0]["support"] == 3
        assert ranked[1]["inconsistency"] == 3

        evidence = {item["id"]: item for item in response.data["evidence"]}
        assert evidence[against_h1.id]["diagnostic"] is True
        assert evidence[both.id]["diagnostic"] is False
        assert len(response.data["cells"]) == 5

    @pytest.mark.django_db
    def test_not_a_question(self, session_client, base_url, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        response = session_client.get(f"{base_url}/issues/{hypothesis.id}/research-matrix/")
        assert response.status_code == status.HTTP_404_NOT_FOUND


@pytest.mark.contract
class TestNeighbourRefresh:
    @pytest.mark.django_db
    def test_archiving_evidence_flags_and_restoring_clears(self, session_client, base_url, workspace, project, link):
        # Only completed or cancelled work items can be archived
        done = State.objects.create(name="Done", group="completed", project=project, workspace=workspace)
        hypothesis = Issue(name="H", project=project, workspace=workspace, research_type="hypothesis")
        hypothesis.research_status = "confirmed"
        hypothesis.save()
        evidence = Issue(
            name="R",
            project=project,
            workspace=workspace,
            research_type="evidence",
            research_status="valid",
            state=done,
        )
        evidence.save()
        link(evidence, hypothesis, "supports", weight=2)

        response = session_client.post(f"{base_url}/issues/{evidence.id}/archive/")
        assert response.status_code == status.HTTP_200_OK, response.data
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is True

        response = session_client.delete(f"{base_url}/issues/{evidence.id}/archive/")
        assert response.status_code == status.HTTP_204_NO_CONTENT
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is False

    @pytest.mark.django_db
    def test_deleting_hypothesis_reopens_question(self, session_client, base_url, make_node, link):
        question = make_node("question", "answered")
        hypothesis = make_node("hypothesis", "confirmed")
        link(hypothesis, question, "addresses")

        response = session_client.delete(f"{base_url}/issues/{hypothesis.id}/")
        assert response.status_code == status.HTTP_204_NO_CONTENT
        question.refresh_from_db()
        assert question.research_status == "open"
