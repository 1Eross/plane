# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q

# Module imports
from .project import ProjectBaseModel


class ResearchNodeType(models.TextChoices):
    QUESTION = "question", "Question"
    HYPOTHESIS = "hypothesis", "Hypothesis"
    EXPERIMENT = "experiment", "Experiment"
    EVIDENCE = "evidence", "Evidence"


class ResearchStatus(models.TextChoices):
    # question
    OPEN = "open", "Open"
    ANSWERED = "answered", "Answered"
    CLOSED = "closed", "Closed"
    # hypothesis
    PROPOSED = "proposed", "Proposed"
    TESTING = "testing", "Testing"
    CONFIRMED = "confirmed", "Confirmed"
    REJECTED = "rejected", "Rejected"
    INCONCLUSIVE = "inconclusive", "Inconclusive"
    SUPERSEDED = "superseded", "Superseded"
    # evidence
    VALID = "valid", "Valid"
    INVALIDATED = "invalidated", "Invalidated"


class IssueResearchDetails(ProjectBaseModel):
    issue = models.OneToOneField("db.Issue", on_delete=models.CASCADE, related_name="research")
    statement = models.TextField(blank=True, default="")
    success_criteria = models.TextField(blank=True, default="")
    conclusion_html = models.TextField(blank=True, default="<p></p>")
    confidence = models.PositiveSmallIntegerField(
        null=True, blank=True, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    verdict_at = models.DateTimeField(null=True, blank=True)
    verdict_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="research_verdicts",
    )
    # Reproducibility of evidence
    repo_url = models.URLField(max_length=800, blank=True, default="")
    branch = models.CharField(max_length=255, blank=True, default="")
    commit_sha = models.CharField(max_length=64, blank=True, default="")
    artifact_url = models.URLField(max_length=800, blank=True, default="")

    class Meta:
        verbose_name = "Issue Research Details"
        verbose_name_plural = "Issue Research Details"
        db_table = "issue_research_details"
        ordering = ("-created_at",)

    def __str__(self):
        return f"{self.issue_id} research details"


class ResearchGraphLayout(ProjectBaseModel):
    class ScopeType(models.TextChoices):
        PROJECT = "project", "Project"
        CYCLE = "cycle", "Cycle"
        MODULE = "module", "Module"
        VIEW = "view", "View"

    scope_type = models.CharField(max_length=20, choices=ScopeType.choices)
    scope_id = models.UUIDField()
    # {issue_id: {"x": float, "y": float, "collapsed": bool}}
    nodes = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "Research Graph Layout"
        verbose_name_plural = "Research Graph Layouts"
        db_table = "research_graph_layouts"
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=["project", "scope_type", "scope_id"],
                condition=Q(deleted_at__isnull=True),
                name="research_graph_layout_unique_scope_when_deleted_at_null",
            )
        ]

    def __str__(self):
        return f"{self.scope_type}:{self.scope_id}"
