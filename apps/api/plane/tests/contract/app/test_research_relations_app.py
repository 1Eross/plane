# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Contract tests for research graph relations and statuses on the app API."""

import pytest
from rest_framework import status

from plane.db.models import Issue, IssueRelation, IssueResearchDetails, Project, ProjectMember

RELATIONS_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{issue_id}/issue-relation/"
RELATION_DETAIL_URL = RELATIONS_URL + "{related_issue_id}/"
REMOVE_RELATION_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{issue_id}/remove-relation/"
ISSUE_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/{issue_id}/"
ISSUES_URL = "/api/workspaces/{slug}/projects/{project_id}/issues/"


@pytest.fixture
def project(db, workspace, create_user):
    project = Project.objects.create(name="Research", identifier="RND", workspace=workspace, created_by=create_user)
    ProjectMember.objects.create(project=project, member=create_user, workspace=workspace, role=20)
    return project


@pytest.fixture
def make_node(project, workspace, create_user):
    def _make(research_type, research_status=None, name=None):
        issue = Issue(
            name=name or f"{research_type or 'task'} node",
            project=project,
            workspace=workspace,
            research_type=research_type,
            research_status=research_status,
        )
        issue.save(created_by_id=create_user.id)
        return issue

    return _make


@pytest.fixture
def urls(workspace, project):
    def _urls(issue, related=None):
        params = {"slug": workspace.slug, "project_id": project.id, "issue_id": issue.id}
        return {
            "relations": RELATIONS_URL.format(**params),
            "remove": REMOVE_RELATION_URL.format(**params),
            "issue": ISSUE_URL.format(**params),
            "detail": RELATION_DETAIL_URL.format(**params, related_issue_id=related.id) if related else None,
        }

    return _urls


def _relate(session_client, urls, issue, relation_type, related, **extra):
    return session_client.post(
        urls(issue)["relations"],
        {"relation_type": relation_type, "issues": [str(item.id) for item in related], **extra},
        format="json",
    )


@pytest.mark.contract
class TestResearchRelationCreate:
    @pytest.mark.django_db
    def test_forward_relation(self, session_client, urls, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        question = make_node("question", "open")
        response = _relate(session_client, urls, hypothesis, "addresses", [question])
        assert response.status_code == status.HTTP_201_CREATED
        assert IssueRelation.objects.filter(
            issue=hypothesis, related_issue=question, relation_type="addresses"
        ).exists()

    @pytest.mark.django_db
    @pytest.mark.parametrize(
        "reverse_name,target_type,source_type,stored",
        [
            ("addressed_by", "question", "hypothesis", "addresses"),
            ("tested_by", "hypothesis", "experiment", "tests"),
            ("produced_by", "evidence", "experiment", "produces"),
            ("informed_by", "question", "evidence", "informs"),
            ("raised_by", "question", "evidence", "raises"),
            ("derives", "hypothesis", "hypothesis", "derived_from"),
        ],
    )
    def test_reverse_name_stored_forward(
        self, session_client, urls, make_node, reverse_name, target_type, source_type, stored
    ):
        target = make_node(target_type)
        source = make_node(source_type)
        response = _relate(session_client, urls, target, reverse_name, [source])
        assert response.status_code == status.HTTP_201_CREATED, response.data
        relation = IssueRelation.objects.get(issue=source, related_issue=target)
        assert relation.relation_type == stored

    @pytest.mark.django_db
    def test_grammar_violation(self, session_client, urls, make_node):
        experiment = make_node("experiment")
        question = make_node("question", "open")
        response = _relate(session_client, urls, experiment, "addresses", [question])
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert not IssueRelation.objects.exists()

    @pytest.mark.django_db
    def test_unknown_relation_type(self, session_client, urls, make_node):
        response = _relate(session_client, urls, make_node(None), "parent_of", [make_node(None)])
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_duplicate_pair_conflicts(self, session_client, urls, make_node):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        assert _relate(session_client, urls, evidence, "supports", [hypothesis], weight=2).status_code == 201
        response = _relate(session_client, urls, evidence, "opposes", [hypothesis], weight=1)
        assert response.status_code == status.HTTP_409_CONFLICT
        assert IssueRelation.objects.get(issue=evidence).relation_type == "supports"

    @pytest.mark.django_db
    def test_cycle_rejected(self, session_client, urls, make_node):
        q1, q2 = make_node("question", "open"), make_node("question", "open")
        q3 = make_node("question", "open")
        assert _relate(session_client, urls, q1, "raises", [q2]).status_code == 201
        assert _relate(session_client, urls, q2, "raises", [q3]).status_code == 201
        response = _relate(session_client, urls, q3, "raises", [q1])
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "cycle" in response.data["error"]

    @pytest.mark.django_db
    def test_weight_rules(self, session_client, urls, make_node):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        assert _relate(session_client, urls, evidence, "supports", [hypothesis]).status_code == 400
        assert _relate(session_client, urls, evidence, "supports", [hypothesis], weight=5).status_code == 400
        response = _relate(session_client, urls, evidence, "supports", [hypothesis], weight=3)
        assert response.status_code == 201
        assert IssueRelation.objects.get(issue=evidence).weight == 3

    @pytest.mark.django_db
    def test_merge_parents(self, session_client, urls, make_node):
        merged = make_node("hypothesis")
        h1, h2 = make_node("hypothesis"), make_node("hypothesis")
        response = _relate(session_client, urls, merged, "derived_from", [h1, h2])
        assert response.status_code == status.HTTP_201_CREATED
        assert IssueRelation.objects.filter(issue=merged, relation_type="derived_from").count() == 2


@pytest.mark.contract
class TestResearchRelationListUpdateRemove:
    @pytest.mark.django_db
    def test_list_uses_names_seen_from_the_issue(self, session_client, urls, make_node):
        question = make_node("question", "open")
        hypothesis = make_node("hypothesis", "proposed")
        evidence = make_node("evidence", "valid")
        _relate(session_client, urls, hypothesis, "addresses", [question])
        _relate(session_client, urls, evidence, "supports", [hypothesis], weight=2)

        response = session_client.get(urls(hypothesis)["relations"])
        assert response.status_code == status.HTTP_200_OK
        assert [item["id"] for item in response.data["addresses"]] == [question.id]
        supported_by = response.data["supported_by"]
        assert [item["id"] for item in supported_by] == [evidence.id]
        assert supported_by[0]["weight"] == 2
        assert supported_by[0]["research_type"] == "evidence"
        assert supported_by[0]["relation_type"] == "supported_by"

        response = session_client.get(urls(question)["relations"])
        assert [item["id"] for item in response.data["addressed_by"]] == [hypothesis.id]

    @pytest.mark.django_db
    def test_patch_switches_supports_and_opposes(self, session_client, urls, make_node):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        _relate(session_client, urls, evidence, "supports", [hypothesis], weight=1)

        # PATCH from the hypothesis side, using the reverse name
        response = session_client.patch(
            urls(hypothesis, evidence)["detail"], {"relation_type": "opposed_by", "weight": 3}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK, response.data
        relation = IssueRelation.objects.get(issue=evidence, related_issue=hypothesis)
        assert relation.relation_type == "opposes"
        assert relation.weight == 3

    @pytest.mark.django_db
    def test_patch_rejects_other_types(self, session_client, urls, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        question = make_node("question", "open")
        _relate(session_client, urls, hypothesis, "addresses", [question])
        response = session_client.patch(urls(hypothesis, question)["detail"], {"weight": 2}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

        evidence = make_node("evidence", "valid")
        _relate(session_client, urls, evidence, "supports", [hypothesis], weight=1)
        response = session_client.patch(
            urls(evidence, hypothesis)["detail"], {"relation_type": "informs"}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_patch_missing_relation(self, session_client, urls, make_node):
        a, b = make_node("evidence", "valid"), make_node("hypothesis")
        response = session_client.patch(urls(a, b)["detail"], {"weight": 2}, format="json")
        assert response.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.django_db
    def test_remove_by_type_and_flag_hypothesis(self, session_client, urls, make_node):
        hypothesis = make_node("hypothesis", "testing")
        evidence = make_node("evidence", "valid")
        _relate(session_client, urls, evidence, "supports", [hypothesis], weight=2)
        response = session_client.patch(urls(hypothesis)["issue"], {"research_status": "confirmed"}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data

        response = session_client.post(
            urls(hypothesis)["remove"],
            {"related_issue": str(evidence.id), "relation_type": "relates_to"},
            format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

        response = session_client.post(
            urls(hypothesis)["remove"],
            {"related_issue": str(evidence.id), "relation_type": "supported_by"},
            format="json",
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not IssueRelation.objects.exists()
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is True


@pytest.mark.contract
class TestResearchIssueStatus:
    @pytest.mark.django_db
    def test_create_sets_initial_status(self, session_client, workspace, project):
        response = session_client.post(
            ISSUES_URL.format(slug=workspace.slug, project_id=project.id),
            {"name": "Why is it slow?", "research_type": "question"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED, response.data
        issue = Issue.objects.get(pk=response.data["id"])
        assert issue.research_type == "question"
        assert issue.research_status == "open"

    @pytest.mark.django_db
    def test_verdict_requires_evidence(self, session_client, urls, make_node):
        hypothesis = make_node("hypothesis", "testing")
        response = session_client.patch(urls(hypothesis)["issue"], {"research_status": "confirmed"}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        hypothesis.refresh_from_db()
        assert hypothesis.research_status == "testing"

    @pytest.mark.django_db
    def test_confirmed_hypothesis_answers_question(self, session_client, urls, make_node, create_user):
        question = make_node("question", "open")
        hypothesis = make_node("hypothesis", "testing")
        evidence = make_node("evidence", "valid")
        _relate(session_client, urls, hypothesis, "addresses", [question])
        _relate(session_client, urls, evidence, "supports", [hypothesis], weight=3)

        response = session_client.patch(urls(hypothesis)["issue"], {"research_status": "confirmed"}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data

        question.refresh_from_db()
        assert question.research_status == "answered"
        details = IssueResearchDetails.objects.get(issue=hypothesis)
        assert details.verdict_by_id == create_user.id
        assert details.verdict_at is not None

        # Invalidating the only evidence flags the verdict for review
        response = session_client.patch(urls(evidence)["issue"], {"research_status": "invalidated"}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT, response.data
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is True

    @pytest.mark.django_db
    def test_needs_review_is_read_only(self, session_client, urls, make_node):
        hypothesis = make_node("hypothesis", "testing")
        session_client.patch(urls(hypothesis)["issue"], {"needs_review": True}, format="json")
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is False

    @pytest.mark.django_db
    def test_answered_cannot_be_set(self, session_client, urls, make_node):
        question = make_node("question", "open")
        response = session_client.patch(urls(question)["issue"], {"research_status": "answered"}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.django_db
    def test_research_fields_in_issue_list(self, session_client, workspace, project, make_node):
        make_node("hypothesis", "proposed")
        response = session_client.get(ISSUES_URL.format(slug=workspace.slug, project_id=project.id))
        assert response.status_code == status.HTTP_200_OK
        results = response.data["results"] if isinstance(response.data, dict) else response.data
        assert results[0]["research_type"] == "hypothesis"
        assert results[0]["research_status"] == "proposed"
        assert results[0]["needs_review"] is False


@pytest.mark.contract
class TestLegacyRelationsRegression:
    @pytest.mark.django_db
    def test_blocking_stored_as_blocked_by(self, session_client, urls, make_node):
        a, b = make_node(None), make_node(None)
        response = _relate(session_client, urls, a, "blocking", [b])
        assert response.status_code == status.HTTP_201_CREATED
        assert IssueRelation.objects.get(issue=b, related_issue=a).relation_type == "blocked_by"

        response = session_client.get(urls(a)["relations"])
        assert [item["id"] for item in response.data["blocking"]] == [b.id]
        response = session_client.get(urls(b)["relations"])
        assert [item["id"] for item in response.data["blocked_by"]] == [a.id]

    @pytest.mark.django_db
    def test_relates_to_listed_on_both_sides(self, session_client, urls, make_node):
        a, b = make_node(None), make_node(None)
        _relate(session_client, urls, a, "relates_to", [b])
        assert [item["id"] for item in session_client.get(urls(a)["relations"]).data["relates_to"]] == [b.id]
        assert [item["id"] for item in session_client.get(urls(b)["relations"]).data["relates_to"]] == [a.id]

    @pytest.mark.django_db
    def test_duplicate_legacy_relation_still_ignored(self, session_client, urls, make_node):
        a, b = make_node(None), make_node(None)
        assert _relate(session_client, urls, a, "relates_to", [b]).status_code == 201
        assert _relate(session_client, urls, a, "relates_to", [b]).status_code == 201
        assert IssueRelation.objects.count() == 1

    @pytest.mark.django_db
    def test_implemented_by_is_listed(self, session_client, urls, make_node):
        a, b = make_node(None), make_node(None)
        _relate(session_client, urls, a, "implemented_by", [b])
        assert [item["id"] for item in session_client.get(urls(a)["relations"]).data["implemented_by"]] == [b.id]
        assert [item["id"] for item in session_client.get(urls(b)["relations"]).data["implements"]] == [a.id]

    @pytest.mark.django_db
    def test_remove_without_type(self, session_client, urls, make_node):
        a, b = make_node(None), make_node(None)
        _relate(session_client, urls, a, "blocked_by", [b])
        response = session_client.post(urls(a)["remove"], {"related_issue": str(b.id)}, format="json")
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not IssueRelation.objects.exists()
