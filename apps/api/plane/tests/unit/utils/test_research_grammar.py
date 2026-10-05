# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Unit tests for the research graph rules in ``plane.utils.research_grammar``."""

import pytest

from plane.db.models import Issue, IssueRelation, IssueResearchDetails, Project
from plane.utils.issue_relation_mapper import (
    get_actual_relation,
    get_all_relation_types,
    get_inverse_relation,
    is_reverse_relation,
)
from plane.utils.research_grammar import (
    RELATION_GRAMMAR,
    ResearchRuleError,
    apply_issue_research_side_effects,
    grammar_allows,
    prepare_relation_pairs,
    recheck_verdict_basis,
    recompute_question_status,
    validate_research_attrs,
    validate_research_relation,
    would_create_cycle,
)

NODE_TYPES = ["question", "hypothesis", "experiment", "evidence", None]


@pytest.fixture
def project(db, workspace, create_user):
    return Project.objects.create(name="Research", identifier="RND", workspace=workspace, created_by=create_user)


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


@pytest.mark.unit
class TestRelationMapper:
    def test_legacy_mappings_unchanged(self):
        assert get_actual_relation("blocking") == "blocked_by"
        assert get_actual_relation("start_after") == "start_before"
        assert get_actual_relation("relates_to") == "relates_to"
        assert get_inverse_relation("blocked_by") == "blocking"
        assert get_inverse_relation("blocking") == "blocked_by"
        assert get_inverse_relation("duplicate") == "duplicate"
        assert get_inverse_relation("implements") == "implemented_by"

    def test_research_reverse_names(self):
        assert get_actual_relation("addressed_by") == "addresses"
        assert get_actual_relation("derives") == "derived_from"
        assert get_inverse_relation("supports") == "supported_by"
        assert is_reverse_relation("tested_by")
        assert not is_reverse_relation("tests")
        assert not is_reverse_relation("relates_to")

    def test_all_relation_types(self):
        names = get_all_relation_types()
        assert len(names) == len(set(names))
        for name in ["blocking", "implemented_by", "implements", "addresses", "addressed_by", "raised_by"]:
            assert name in names


@pytest.mark.unit
class TestGrammar:
    @pytest.mark.parametrize(
        "relation_type,source,target",
        [
            ("addresses", "hypothesis", "question"),
            ("tests", "experiment", "hypothesis"),
            ("produces", "experiment", "evidence"),
            ("supports", "evidence", "hypothesis"),
            ("opposes", "evidence", "hypothesis"),
            ("informs", "evidence", "question"),
            ("raises", "question", "question"),
            ("raises", "hypothesis", "question"),
            ("raises", "experiment", "question"),
            ("raises", "evidence", "question"),
            ("derived_from", "hypothesis", "hypothesis"),
        ],
    )
    def test_allowed_pairs(self, relation_type, source, target):
        assert grammar_allows(relation_type, source, target)

    def test_everything_else_is_rejected(self):
        allowed = {
            ("addresses", "hypothesis", "question"),
            ("tests", "experiment", "hypothesis"),
            ("produces", "experiment", "evidence"),
            ("supports", "evidence", "hypothesis"),
            ("opposes", "evidence", "hypothesis"),
            ("informs", "evidence", "question"),
            ("derived_from", "hypothesis", "hypothesis"),
        } | {("raises", source, "question") for source in ["question", "hypothesis", "experiment", "evidence"]}
        for relation_type in RELATION_GRAMMAR:
            for source in NODE_TYPES:
                for target in NODE_TYPES:
                    expected = (relation_type, source, target) in allowed
                    assert grammar_allows(relation_type, source, target) is expected, (relation_type, source, target)


@pytest.mark.unit
@pytest.mark.django_db
class TestRelationValidation:
    def test_self_relation_rejected(self, make_node):
        question = make_node("question")
        with pytest.raises(ResearchRuleError):
            validate_research_relation(question, question, "raises")

    def test_wrong_node_types_rejected(self, make_node):
        hypothesis = make_node("hypothesis")
        experiment = make_node("experiment")
        with pytest.raises(ResearchRuleError, match="cannot link"):
            validate_research_relation(hypothesis, experiment, "addresses")

    def test_regular_work_item_rejected(self, make_node):
        task = make_node(None)
        question = make_node("question")
        with pytest.raises(ResearchRuleError):
            validate_research_relation(task, question, "raises")

    def test_weight_required_for_supports(self, make_node):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        with pytest.raises(ResearchRuleError, match="weight"):
            validate_research_relation(evidence, hypothesis, "supports")
        with pytest.raises(ResearchRuleError, match="weight"):
            validate_research_relation(evidence, hypothesis, "supports", weight=4)
        validate_research_relation(evidence, hypothesis, "supports", weight=2)

    def test_weight_forbidden_elsewhere(self, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        question = make_node("question", "open")
        with pytest.raises(ResearchRuleError, match="does not take a weight"):
            validate_research_relation(hypothesis, question, "addresses", weight=1)

    def test_existing_pair_conflicts_in_either_direction(self, make_node, link):
        evidence = make_node("evidence", "valid")
        hypothesis = make_node("hypothesis", "proposed")
        link(evidence, hypothesis, "supports", weight=1)
        with pytest.raises(ResearchRuleError) as error:
            validate_research_relation(evidence, hypothesis, "opposes", weight=1)
        assert error.value.status_code == 409

        question = make_node("question", "open")
        link(question, make_node("question", "open"), "raises")
        other = IssueRelation.objects.get(issue=question).related_issue
        with pytest.raises(ResearchRuleError) as error:
            validate_research_relation(other, question, "raises")
        assert error.value.status_code == 409


@pytest.mark.unit
@pytest.mark.django_db
class TestCycles:
    def test_raises_chain_cycle(self, make_node, link):
        q1, q2, q3 = make_node("question"), make_node("question"), make_node("question")
        link(q1, q2, "raises")
        link(q2, q3, "raises")
        assert would_create_cycle(q3.id, q1.id)
        assert not would_create_cycle(q1.id, q3.id)

    def test_derived_from_cycle(self, make_node, link):
        h1, h2, h3 = make_node("hypothesis"), make_node("hypothesis"), make_node("hypothesis")
        link(h1, h2, "derived_from")
        link(h2, h3, "derived_from")
        with pytest.raises(ResearchRuleError, match="cycle"):
            validate_research_relation(h3, h1, "derived_from")

    def test_merge_with_several_parents_is_not_a_cycle(self, make_node, link):
        h1, h2, merged = make_node("hypothesis"), make_node("hypothesis"), make_node("hypothesis")
        link(merged, h1, "derived_from")
        validate_research_relation(merged, h2, "derived_from")

    def test_deleted_relations_are_ignored(self, make_node, link):
        q1, q2 = make_node("question"), make_node("question")
        relation = link(q1, q2, "raises")
        relation.delete()
        assert not would_create_cycle(q2.id, q1.id)

    def test_research_flow_is_not_a_cycle(self, make_node, link):
        # Q <- H <- E -> R -> Q2 and R supports H: evidence feeding back is legitimate
        question = make_node("question")
        hypothesis = make_node("hypothesis")
        experiment = make_node("experiment")
        evidence = make_node("evidence", "valid")
        new_question = make_node("question")
        link(hypothesis, question, "addresses")
        link(experiment, hypothesis, "tests")
        link(experiment, evidence, "produces")
        link(evidence, new_question, "raises")
        validate_research_relation(evidence, hypothesis, "supports", weight=1)
        validate_research_relation(new_question, question, "raises")


@pytest.mark.unit
@pytest.mark.django_db
class TestPrepareRelationPairs:
    def test_reverse_name_is_stored_forward(self, make_node, workspace):
        question = make_node("question")
        hypothesis = make_node("hypothesis")
        stored, pairs, is_research = prepare_relation_pairs(
            question.id, "addressed_by", [hypothesis.id], workspace.slug
        )
        assert stored == "addresses"
        assert pairs == [(hypothesis.id, question.id)]
        assert is_research

    def test_legacy_relation_passes_through(self, make_node, workspace):
        a, b = make_node(None), make_node(None)
        stored, pairs, is_research = prepare_relation_pairs(a.id, "blocking", [b.id], workspace.slug)
        assert stored == "blocked_by"
        assert pairs == [(b.id, a.id)]
        assert not is_research

    def test_legacy_relation_rejects_weight(self, make_node, workspace):
        a, b = make_node(None), make_node(None)
        with pytest.raises(ResearchRuleError):
            prepare_relation_pairs(a.id, "relates_to", [b.id], workspace.slug, weight=2)


@pytest.mark.unit
@pytest.mark.django_db
class TestResearchAttrs:
    def test_initial_status_on_create(self):
        assert validate_research_attrs(None, {"research_type": "question"})["research_status"] == "open"
        assert validate_research_attrs(None, {"research_type": "hypothesis"})["research_status"] == "proposed"
        assert validate_research_attrs(None, {"research_type": "evidence"})["research_status"] == "valid"
        assert validate_research_attrs(None, {"research_type": "experiment"})["research_status"] is None

    def test_untouched_attrs_left_alone(self, make_node):
        hypothesis = make_node("hypothesis", "testing")
        assert validate_research_attrs(hypothesis, {"name": "x"}) == {"name": "x"}

    def test_status_must_match_type(self, make_node):
        hypothesis = make_node("hypothesis", "proposed")
        with pytest.raises(ResearchRuleError, match="not a valid status"):
            validate_research_attrs(hypothesis, {"research_status": "valid"})
        experiment = make_node("experiment")
        with pytest.raises(ResearchRuleError):
            validate_research_attrs(experiment, {"research_status": "open"})

    def test_status_requires_type(self, make_node):
        task = make_node(None)
        with pytest.raises(ResearchRuleError, match="requires a research_type"):
            validate_research_attrs(task, {"research_status": "open"})

    def test_answered_is_computed(self, make_node):
        question = make_node("question", "open")
        with pytest.raises(ResearchRuleError, match="computed"):
            validate_research_attrs(question, {"research_status": "answered"})
        assert validate_research_attrs(question, {"research_status": "closed"})["research_status"] == "closed"

    def test_type_change_resets_status(self, make_node):
        task = make_node(None)
        attrs = validate_research_attrs(task, {"research_type": "hypothesis"})
        assert attrs["research_status"] == "proposed"
        hypothesis = make_node("hypothesis", "testing")
        attrs = validate_research_attrs(hypothesis, {"research_type": None})
        assert attrs["research_status"] is None

    def test_type_change_blocked_by_relations(self, make_node, link):
        hypothesis = make_node("hypothesis", "proposed")
        link(hypothesis, make_node("question", "open"), "addresses")
        with pytest.raises(ResearchRuleError, match="Cannot change the type"):
            validate_research_attrs(hypothesis, {"research_type": "experiment"})
        with pytest.raises(ResearchRuleError, match="Cannot change the type"):
            validate_research_attrs(hypothesis, {"research_type": None})

    def test_raises_survives_type_change(self, make_node, link):
        hypothesis = make_node("hypothesis", "proposed")
        link(hypothesis, make_node("question", "open"), "raises")
        attrs = validate_research_attrs(hypothesis, {"research_type": "evidence"})
        assert attrs["research_status"] == "valid"

    def test_confirmed_needs_supporting_valid_evidence(self, make_node, link):
        hypothesis = make_node("hypothesis", "testing")
        with pytest.raises(ResearchRuleError, match="confirmed"):
            validate_research_attrs(hypothesis, {"research_status": "confirmed"})

        invalid = make_node("evidence", "invalidated")
        link(invalid, hypothesis, "supports", weight=3)
        with pytest.raises(ResearchRuleError):
            validate_research_attrs(hypothesis, {"research_status": "confirmed"})

        opposing = make_node("evidence", "valid")
        link(opposing, hypothesis, "opposes", weight=3)
        with pytest.raises(ResearchRuleError):
            validate_research_attrs(hypothesis, {"research_status": "confirmed"})
        assert validate_research_attrs(hypothesis, {"research_status": "rejected"})["research_status"] == "rejected"

        supporting = make_node("evidence", "valid")
        link(supporting, hypothesis, "supports", weight=1)
        assert validate_research_attrs(hypothesis, {"research_status": "confirmed"})["research_status"] == "confirmed"

    def test_archived_evidence_does_not_count(self, make_node, link):
        hypothesis = make_node("hypothesis", "testing")
        evidence = make_node("evidence", "valid")
        link(evidence, hypothesis, "supports", weight=1)
        Issue.objects.filter(pk=evidence.id).update(archived_at="2026-01-01")
        with pytest.raises(ResearchRuleError):
            validate_research_attrs(hypothesis, {"research_status": "confirmed"})

    def test_inconclusive_needs_no_evidence(self, make_node):
        hypothesis = make_node("hypothesis", "testing")
        assert validate_research_attrs(hypothesis, {"research_status": "inconclusive"})["research_status"] == (
            "inconclusive"
        )

    def test_cannot_create_confirmed(self):
        with pytest.raises(ResearchRuleError):
            validate_research_attrs(None, {"research_type": "hypothesis", "research_status": "confirmed"})


@pytest.mark.unit
@pytest.mark.django_db
class TestSideEffects:
    def test_question_answered_by_confirmed_hypothesis(self, make_node, link):
        question = make_node("question", "open")
        hypothesis = make_node("hypothesis", "confirmed")
        link(hypothesis, question, "addresses")
        recompute_question_status([question.id])
        question.refresh_from_db()
        assert question.research_status == "answered"

        Issue.objects.filter(pk=hypothesis.id).update(research_status="rejected")
        recompute_question_status([question.id])
        question.refresh_from_db()
        assert question.research_status == "open"

    def test_closed_question_left_alone(self, make_node, link):
        question = make_node("question", "closed")
        link(make_node("hypothesis", "confirmed"), question, "addresses")
        recompute_question_status([question.id])
        question.refresh_from_db()
        assert question.research_status == "closed"

    def test_needs_review_when_basis_lost(self, make_node, link):
        hypothesis = make_node("hypothesis", "confirmed")
        evidence = make_node("evidence", "valid")
        relation = link(evidence, hypothesis, "supports", weight=2)
        recheck_verdict_basis([hypothesis.id])
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is False

        relation.delete()
        recheck_verdict_basis([hypothesis.id])
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is True

        link(evidence, hypothesis, "supports", weight=2)
        recheck_verdict_basis([hypothesis.id])
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is False

    def test_evidence_invalidation_flags_hypothesis(self, make_node, link):
        hypothesis = make_node("hypothesis", "rejected")
        evidence = make_node("evidence", "valid")
        link(evidence, hypothesis, "opposes", weight=3)

        Issue.objects.filter(pk=evidence.id).update(research_status="invalidated")
        evidence.refresh_from_db()
        apply_issue_research_side_effects(evidence, "evidence", "valid")
        hypothesis.refresh_from_db()
        assert hypothesis.needs_review is True

    def test_verdict_recorded(self, make_node, link, create_user):
        question = make_node("question", "open")
        hypothesis = make_node("hypothesis", "testing")
        link(hypothesis, question, "addresses")
        link(make_node("evidence", "valid"), hypothesis, "supports", weight=1)

        Issue.objects.filter(pk=hypothesis.id).update(research_status="confirmed")
        hypothesis.refresh_from_db()
        apply_issue_research_side_effects(hypothesis, "hypothesis", "testing", actor_id=create_user.id)

        details = IssueResearchDetails.objects.get(issue=hypothesis)
        assert details.verdict_at is not None
        assert details.verdict_by_id == create_user.id
        question.refresh_from_db()
        assert question.research_status == "answered"

        Issue.objects.filter(pk=hypothesis.id).update(research_status="testing")
        hypothesis.refresh_from_db()
        apply_issue_research_side_effects(hypothesis, "hypothesis", "confirmed", actor_id=create_user.id)
        details.refresh_from_db()
        assert details.verdict_at is None
        question.refresh_from_db()
        assert question.research_status == "open"
