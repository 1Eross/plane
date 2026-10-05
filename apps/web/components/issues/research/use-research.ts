/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import useSWR from "swr";
// plane imports
import { RESEARCH_REVERSE_RELATION, RESEARCH_VERDICT_BASIS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { setToast } from "@plane/blocks/toast";
import { EIssueServiceType } from "@plane/types";
import type { TIssue, TIssueServiceType, TResearchStatus } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";

/** The research API answers rule violations with { error: "..." } (or a list of messages). */
export const getResearchErrorMessage = (error: unknown): string | undefined => {
  const value = (error as { error?: unknown } | undefined)?.error;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
};

export const useResearchErrorToast = () => {
  const { t } = useTranslation();
  return useCallback(
    (error: unknown) =>
      setToast({
        type: "error",
        title: t("toast.error"),
        message: getResearchErrorMessage(error) ?? t("research.toasts.update_failed"),
      }),
    [t]
  );
};

/** Whether the research UI applies: the project enabled the research graph or the item already is a research node. */
export const useIsResearchEnabled = (issue: TIssue | undefined) => {
  const { getProjectById } = useProject();
  const project = issue?.project_id ? getProjectById(issue.project_id) : undefined;
  return !!project?.research_graph_view || !!issue?.research_type;
};

/** Loads research details and research relations of a work item; SWR dedupes the widget and the sidebar. */
export const useResearchData = (
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  issueServiceType: TIssueServiceType = EIssueServiceType.ISSUES
) => {
  const {
    issue: { getIssueById },
    research: { fetchDetails, fetchResearchRelations },
  } = useIssueDetail(issueServiceType);
  const issue = getIssueById(issueId);
  const shouldFetch = !!workspaceSlug && !!projectId && !!issueId && !!issue?.research_type;

  return useSWR(
    shouldFetch ? `RESEARCH_DATA_${issueId}` : null,
    async () => {
      await Promise.all([
        fetchDetails(workspaceSlug, projectId, issueId),
        fetchResearchRelations(workspaceSlug, projectId, issueId),
      ]);
      return true;
    },
    { revalidateOnFocus: false }
  );
};

/** Update research type / status, showing the server's reason when a research rule rejects it. */
export const useResearchIssueUpdate = (
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  issueServiceType: TIssueServiceType = EIssueServiceType.ISSUES
) => {
  const {
    updateIssue,
    research: { fetchDetails },
  } = useIssueDetail(issueServiceType);
  const showError = useResearchErrorToast();

  return useCallback(
    async (data: Pick<Partial<TIssue>, "research_type" | "research_status">) => {
      try {
        await updateIssue(workspaceSlug, projectId, issueId, data);
        // the server may recompute status / needs_review
        if (data.research_type !== null) await fetchDetails(workspaceSlug, projectId, issueId);
      } catch (error) {
        showError(error);
      }
    },
    [fetchDetails, issueId, projectId, showError, updateIssue, workspaceSlug]
  );
};

/** Client-side mirror of the verdict rule, to explain why a verdict is unavailable before the server says so. */
export const useVerdictBasis = (issueId: string, issueServiceType: TIssueServiceType = EIssueServiceType.ISSUES) => {
  const {
    issue: { getIssueById },
    relation: { getRelationsByIssueId },
  } = useIssueDetail(issueServiceType);

  return useCallback(
    (status: TResearchStatus): boolean => {
      const relation = RESEARCH_VERDICT_BASIS[status];
      if (!relation) return true;
      const evidenceIds = getRelationsByIssueId(issueId)?.[RESEARCH_REVERSE_RELATION[relation]] ?? [];
      return evidenceIds.some((evidenceId) => {
        const evidence = getIssueById(evidenceId);
        return evidence?.research_type === "evidence" && evidence.research_status === "valid" && !evidence.archived_at;
      });
    },
    [getIssueById, getRelationsByIssueId, issueId]
  );
};
