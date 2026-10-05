/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TIssueActivity } from "@plane/types";
import { isResearchRelation } from "@plane/utils";

export const getRelationActivityContent = (activity: TIssueActivity | undefined): string | undefined => {
  if (!activity) return;

  switch (activity.field) {
    case "blocking":
      return activity.old_value === ""
        ? `marked this work item is blocking work item `
        : `removed the blocking work item `;
    case "blocked_by":
      return activity.old_value === ""
        ? `marked this work item is being blocked by `
        : `removed this work item being blocked by work item `;
    case "duplicate":
      return activity.old_value === ""
        ? `marked this work item as duplicate of `
        : `removed this work item as a duplicate of `;
    case "relates_to":
      return activity.old_value === "" ? `marked that this work item relates to ` : `removed the relation from `;
  }

  if (activity.field && isResearchRelation(activity.field)) {
    const relationLabel = activity.field.replace(/_/g, " ");
    return activity.old_value === ""
      ? `added a "${relationLabel}" research link to `
      : `removed the "${relationLabel}" research link to `;
  }

  return;
};
