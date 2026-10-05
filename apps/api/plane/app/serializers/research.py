# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import math
import re

# Third Party imports
from rest_framework import serializers

# Module imports
from .base import BaseSerializer
from plane.db.models import IssueResearchDetails
from plane.utils.content_validator import validate_html_content

COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{7,64}$")
MAX_LAYOUT_NODES = 5000


class IssueResearchDetailsSerializer(BaseSerializer):
    issue_id = serializers.UUIDField(read_only=True)
    verdict_by_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = IssueResearchDetails
        fields = [
            "issue_id",
            "statement",
            "success_criteria",
            "conclusion_html",
            "confidence",
            "repo_url",
            "branch",
            "commit_sha",
            "artifact_url",
            "verdict_at",
            "verdict_by_id",
            "updated_at",
        ]
        read_only_fields = ["issue_id", "verdict_at", "verdict_by_id", "updated_at"]

    def validate_conclusion_html(self, value):
        if not value:
            return "<p></p>"
        is_valid, _, sanitized_html = validate_html_content(value)
        if not is_valid:
            raise serializers.ValidationError("html content is not valid")
        return sanitized_html if sanitized_html is not None else value

    def validate_commit_sha(self, value):
        if value and not COMMIT_SHA_PATTERN.match(value):
            raise serializers.ValidationError("Commit SHA must be 7-64 hexadecimal characters")
        return value


class ResearchMergeSerializer(serializers.Serializer):
    hypothesis_ids = serializers.ListField(child=serializers.UUIDField(), min_length=2, max_length=20)
    name = serializers.CharField(max_length=255)

    def validate_hypothesis_ids(self, value):
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Hypotheses must be distinct")
        return value


class ResearchGraphLayoutSerializer(serializers.Serializer):
    # {issue_id: {"x": float, "y": float, "collapsed": bool}}
    nodes = serializers.DictField(child=serializers.DictField(), allow_empty=True)

    def validate_nodes(self, value):
        if len(value) > MAX_LAYOUT_NODES:
            raise serializers.ValidationError(f"At most {MAX_LAYOUT_NODES} nodes can be stored")
        uuid_field = serializers.UUIDField()
        cleaned = {}
        for issue_id, node in value.items():
            try:
                issue_id = str(uuid_field.to_internal_value(issue_id))
            except serializers.ValidationError:
                raise serializers.ValidationError(f"'{issue_id}' is not a valid work item id")
            entry = {}
            for axis in ("x", "y"):
                coordinate = node.get(axis)
                if coordinate is None:
                    continue
                if (
                    isinstance(coordinate, bool)
                    or not isinstance(coordinate, (int, float))
                    or not math.isfinite(coordinate)
                ):
                    raise serializers.ValidationError(f"'{axis}' of {issue_id} must be a finite number")
                entry[axis] = float(coordinate)
            if "collapsed" in node:
                if not isinstance(node["collapsed"], bool):
                    raise serializers.ValidationError(f"'collapsed' of {issue_id} must be a boolean")
                entry["collapsed"] = node["collapsed"]
            cleaned[issue_id] = entry
        return cleaned
