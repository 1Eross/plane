/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { WarningTriangleOutline } from "@makeplane/propel/icons";
import { Collapsible } from "@makeplane/propel/components/collapsible";
// plane imports
import { RESEARCH_NODE_TYPE_MAP } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// local imports
import { ResearchCollapsibleContent } from "./content";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled?: boolean;
  issueServiceType: TIssueServiceType;
};

export const ResearchCollapsible = observer(function ResearchCollapsible(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled = false, issueServiceType } = props;
  const { t } = useTranslation();
  // store hooks
  const {
    openWidgets,
    toggleOpenWidget,
    issue: { getIssueById },
  } = useIssueDetail(issueServiceType);
  // derived values
  const issue = getIssueById(issueId);
  const isCollapsibleOpen = openWidgets.includes("research");
  const nodeType = issue?.research_type ? RESEARCH_NODE_TYPE_MAP[issue.research_type] : undefined;

  if (!nodeType) return null;

  return (
    <Collapsible
      open={isCollapsibleOpen}
      onOpenChange={() => toggleOpenWidget("research")}
      trigger={
        <span className="inline-flex items-center gap-2">
          {t("research.widget.title")}
          <span className="text-12 font-medium" style={{ color: nodeType.color }}>
            {t(nodeType.i18n_label)}
          </span>
          {issue?.needs_review && (
            <WarningTriangleOutline className="size-3.5 text-warning-primary" aria-label={t("research.needs_review")} />
          )}
        </span>
      }
    >
      <ResearchCollapsibleContent
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        disabled={disabled}
        issueServiceType={issueServiceType}
      />
    </Collapsible>
  );
});
