/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { StateOutline, WorkgraphOutline } from "@makeplane/propel/icons";
// plane imports
import {
  COMPUTED_RESEARCH_STATUSES,
  RESEARCH_NODE_TYPE_MAP,
  RESEARCH_NODE_TYPES,
  RESEARCH_STATUS_MAP,
  RESEARCH_STATUSES_BY_TYPE,
  RESEARCH_VERDICT_BASIS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EIssueServiceType } from "@plane/types";
import type { TIssueServiceType, TResearchNodeType, TResearchStatus } from "@plane/types";
// components
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// local imports
import { ResearchSelect } from "./research-select";
import type { TResearchSelectOption } from "./research-select";
import { useIsResearchEnabled, useResearchData, useResearchIssueUpdate, useVerdictBasis } from "./use-research";

const NONE = "none";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  issueServiceType?: TIssueServiceType;
};

/** "Research type" and "Research status" rows for the work item sidebar and the peek overview. */
export const ResearchPropertyRows = observer(function ResearchPropertyRows(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled, issueServiceType = EIssueServiceType.ISSUES } = props;
  const { t } = useTranslation();
  const {
    issue: { getIssueById },
  } = useIssueDetail(issueServiceType);
  const issue = getIssueById(issueId);
  const isResearchEnabled = useIsResearchEnabled(issue);
  useResearchData(workspaceSlug, projectId, issueId, issueServiceType);
  const updateResearch = useResearchIssueUpdate(workspaceSlug, projectId, issueId, issueServiceType);
  const hasVerdictBasis = useVerdictBasis(issueId, issueServiceType);

  if (!issue || !isResearchEnabled) return null;

  const researchType = issue.research_type ?? null;
  const typeOptions: TResearchSelectOption[] = [
    { key: NONE, label: t("research.fields.none") },
    ...RESEARCH_NODE_TYPES.map((type) => ({
      key: type,
      label: t(RESEARCH_NODE_TYPE_MAP[type].i18n_label),
      color: RESEARCH_NODE_TYPE_MAP[type].color,
    })),
  ];

  const statuses = researchType ? RESEARCH_STATUSES_BY_TYPE[researchType] : [];
  const statusOptions: TResearchSelectOption[] = statuses.map((status) => {
    const basis = RESEARCH_VERDICT_BASIS[status];
    const missingBasis = !!basis && status !== issue.research_status && !hasVerdictBasis(status);
    const isComputed = COMPUTED_RESEARCH_STATUSES.includes(status);
    return {
      key: status,
      label: t(RESEARCH_STATUS_MAP[status].i18n_label),
      color: RESEARCH_STATUS_MAP[status].color,
      hint: missingBasis
        ? t(basis === "supports" ? "research.verdict.requires_supporting" : "research.verdict.requires_opposing")
        : isComputed
          ? t("research.verdict.computed")
          : undefined,
    };
  });

  return (
    <>
      <SidebarPropertyListItem icon={WorkgraphOutline} label={t("research.fields.type")}>
        <ResearchSelect
          options={typeOptions}
          value={researchType ?? NONE}
          placeholder={t("research.fields.none")}
          disabled={disabled}
          onChange={(key) => void updateResearch({ research_type: key === NONE ? null : (key as TResearchNodeType) })}
        />
      </SidebarPropertyListItem>
      {statusOptions.length > 0 && (
        <SidebarPropertyListItem icon={StateOutline} label={t("research.fields.status")}>
          <ResearchSelect
            options={statusOptions}
            value={issue.research_status}
            placeholder={t("research.fields.status")}
            disabled={disabled}
            isOptionDisabled={(option) =>
              option.key !== issue.research_status &&
              (COMPUTED_RESEARCH_STATUSES.includes(option.key as TResearchStatus) || !!option.hint)
            }
            onChange={(key) => void updateResearch({ research_status: key as TResearchStatus })}
          />
        </SidebarPropertyListItem>
      )}
    </>
  );
});
