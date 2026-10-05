# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Module imports
from plane.db.models.issue import IssueRelationChoices

# forward (stored) name -> reverse name, e.g. "blocked_by" -> "blocking"
_FORWARD_TO_REVERSE = dict(IssueRelationChoices._RELATION_PAIRS)
# reverse name -> forward (stored) name, symmetric relations excluded
_REVERSE_TO_FORWARD = {
    reverse: forward for forward, reverse in IssueRelationChoices._RELATION_PAIRS if reverse != forward
}


def get_inverse_relation(relation_type):
    if relation_type in _FORWARD_TO_REVERSE:
        return _FORWARD_TO_REVERSE[relation_type]
    return _REVERSE_TO_FORWARD.get(relation_type, relation_type)


def get_actual_relation(relation_type):
    # This function is used to get the actual relation type which is stored in database
    return _REVERSE_TO_FORWARD.get(relation_type, relation_type)


def is_reverse_relation(relation_type):
    # Reverse names are stored swapped: "A blocking B" is stored as "B blocked_by A"
    return relation_type in _REVERSE_TO_FORWARD


def get_all_relation_types():
    # Every name a client can send or receive: forward and reverse
    names = []
    for forward, reverse in IssueRelationChoices._RELATION_PAIRS:
        names.append(forward)
        if reverse != forward:
            names.append(reverse)
    return names
