/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  AskOutline,
  BlockingOutline,
  CloseCircleOutline,
  DuplicateOfOutline,
  HelpOutline,
  HierarchyOutline,
  InfoOutline,
  LogsOutline,
  MergeOutline,
  RelatesToOutline,
  SandboxOutline,
  ThumbsDownOutline,
  ThumbsUpOutline,
} from "@makeplane/propel/icons";
import { RESEARCH_RELATION_I18N_LABEL } from "@plane/constants";
import type { TIssueRelationTypes, TResearchRelationTypes } from "@plane/types";
import { isResearchRelation } from "@plane/utils";
import type { TRelationObject } from "@/components/issues/issue-detail-widgets/relations";

type TIconComponent = React.FC<{ width?: number | string; height?: number | string; className?: string }>;

const researchRelationOption = (
  key: TResearchRelationTypes,
  Icon: TIconComponent,
  className = "bg-layer-1 text-secondary"
): TRelationObject => ({
  key,
  i18n_label: RESEARCH_RELATION_I18N_LABEL[key],
  className,
  icon: (size) => <Icon width={size} height={size} className="text-secondary" />,
  placeholder: "None",
});

const SUPPORT_CLASS_NAME = "bg-success-subtle text-success-primary";
const OPPOSE_CLASS_NAME = "bg-danger-subtle text-danger-primary";

export const ISSUE_RELATION_OPTIONS: Record<TIssueRelationTypes, TRelationObject> = {
  relates_to: {
    key: "relates_to",
    i18n_label: "issue.relation.relates_to",
    className: "bg-layer-1 text-secondary",
    icon: (size) => <RelatesToOutline height={size} width={size} className="text-secondary" />,
    placeholder: "Add related work items",
  },
  duplicate: {
    key: "duplicate",
    i18n_label: "issue.relation.duplicate",
    className: "bg-layer-1 text-secondary",
    icon: (size) => <DuplicateOfOutline width={size} height={size} className="text-secondary" />,
    placeholder: "None",
  },
  blocked_by: {
    key: "blocked_by",
    i18n_label: "issue.relation.blocked_by",
    className: "bg-danger-subtle text-danger-primary",
    icon: (size) => <BlockingOutline width={size} height={size} className="text-secondary" />,
    placeholder: "None",
  },
  blocking: {
    key: "blocking",
    i18n_label: "issue.relation.blocking",
    className: "bg-yellow-500/20 text-yellow-700",
    icon: (size) => <CloseCircleOutline width={size} height={size} className="text-secondary" />,
    placeholder: "None",
  },
  // research graph relations; created only where the research grammar applies
  addresses: researchRelationOption("addresses", HelpOutline),
  addressed_by: researchRelationOption("addressed_by", HelpOutline),
  tests: researchRelationOption("tests", SandboxOutline),
  tested_by: researchRelationOption("tested_by", SandboxOutline),
  produces: researchRelationOption("produces", LogsOutline),
  produced_by: researchRelationOption("produced_by", LogsOutline),
  supports: researchRelationOption("supports", ThumbsUpOutline, SUPPORT_CLASS_NAME),
  supported_by: researchRelationOption("supported_by", ThumbsUpOutline, SUPPORT_CLASS_NAME),
  opposes: researchRelationOption("opposes", ThumbsDownOutline, OPPOSE_CLASS_NAME),
  opposed_by: researchRelationOption("opposed_by", ThumbsDownOutline, OPPOSE_CLASS_NAME),
  informs: researchRelationOption("informs", InfoOutline),
  informed_by: researchRelationOption("informed_by", InfoOutline),
  raises: researchRelationOption("raises", AskOutline),
  raised_by: researchRelationOption("raised_by", AskOutline),
  derived_from: researchRelationOption("derived_from", HierarchyOutline),
  derives: researchRelationOption("derives", MergeOutline),
};

/** Relations offered by the generic relation picker; research relations need the research grammar. */
export const GENERIC_ISSUE_RELATION_OPTIONS = Object.values(ISSUE_RELATION_OPTIONS).filter(
  (option) => !isResearchRelation(option.key)
);

export const GENERIC_ISSUE_RELATION_OPTIONS_MAP: Partial<Record<TIssueRelationTypes, TRelationObject>> =
  Object.fromEntries(GENERIC_ISSUE_RELATION_OPTIONS.map((option) => [option.key, option]));

export const useTimeLineRelationOptions = () => ISSUE_RELATION_OPTIONS;
