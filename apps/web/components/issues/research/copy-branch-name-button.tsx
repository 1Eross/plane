/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { GitBranchOutline } from "@makeplane/propel/icons";
import { Icon } from "@makeplane/propel/components/icon";
import { IconButton } from "@makeplane/propel/components/icon-button";
import { Tooltip } from "@makeplane/propel/components/tooltip";
// plane imports
import { setToast } from "@plane/blocks/toast";
import { useTranslation } from "@plane/i18n";
import { copyTextToClipboard, getResearchBranchName } from "@plane/utils";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
import { usePlatformOS } from "@/hooks/use-platform-os";
// local imports
import { useIsResearchEnabled } from "./use-research";

type Props = {
  issueId: string;
};

/** Copies a branch name following the repo convention: exp/rnd-57-cache-warmup for experiments, feat/... otherwise. */
export const CopyBranchNameButton = observer(function CopyBranchNameButton(props: Props) {
  const { issueId } = props;
  const { t } = useTranslation();
  const { isMobile } = usePlatformOS();
  const {
    issue: { getIssueById },
  } = useIssueDetail();
  const { getProjectIdentifierById } = useProject();
  const issue = getIssueById(issueId);
  const isResearchEnabled = useIsResearchEnabled(issue);
  const projectIdentifier = issue?.project_id ? getProjectIdentifierById(issue.project_id) : undefined;

  if (!issue || !isResearchEnabled || !projectIdentifier) return null;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const branchName = getResearchBranchName({
      projectIdentifier,
      sequenceId: issue.sequence_id,
      name: issue.name,
      researchType: issue.research_type,
    });
    try {
      await copyTextToClipboard(branchName);
      setToast({ type: "success", title: t("research.toasts.branch_copied"), message: branchName });
    } catch {
      setToast({ type: "error", title: t("toast.error") });
    }
  };

  return (
    <Tooltip label={t("research.actions.copy_branch_name")} disabled={isMobile}>
      <IconButton
        variant="secondary"
        size="md"
        onClick={(e) => void handleCopy(e)}
        icon={<Icon icon={GitBranchOutline} />}
        aria-label={t("research.actions.copy_branch_name")}
      />
    </Tooltip>
  );
});
