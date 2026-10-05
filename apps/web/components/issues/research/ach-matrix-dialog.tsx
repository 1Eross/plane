/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { WarningTriangleOutline } from "@makeplane/propel/icons";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@makeplane/propel/components/menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogMain,
  DialogTitle,
} from "@makeplane/propel/components/dialog";
// plane imports
import { Spinner } from "@plane/blocks/spinner";
import {
  RESEARCH_RELATION_I18N_LABEL,
  RESEARCH_RELATION_WEIGHT_I18N_LABEL,
  RESEARCH_RELATION_WEIGHTS,
  RESEARCH_STATUS_MAP,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TResearchMatrixCell, TResearchRelationWeight } from "@plane/types";
import { cn, rankHypotheses } from "@plane/utils";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useProject } from "@/hooks/store/use-project";
// services
import { ResearchService } from "@/services/issue";
// local imports
import { ColorDot } from "./research-select";
import { useResearchErrorToast } from "./use-research";

const researchService = new ResearchService();

type TCellValue = Pick<TResearchMatrixCell, "relation_type" | "weight"> | undefined;

type Props = {
  workspaceSlug: string;
  projectId: string;
  questionId: string;
  canEdit: boolean;
  onClose: () => void;
};

/**
 * Analysis of Competing Hypotheses for one question: every piece of evidence against every hypothesis.
 * Hypotheses are ranked by the weight of valid evidence against them; "what if" excludes evidence
 * to show how sensitive the ranking is.
 */
export const AchMatrixDialog = observer(function AchMatrixDialog(props: Props) {
  const { workspaceSlug, projectId, questionId, canEdit, onClose } = props;
  const { t } = useTranslation();
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const {
    research: { createResearchRelation, updateResearchRelation, removeResearchRelation },
  } = useIssueDetail();
  const { getProjectIdentifierById } = useProject();
  const showError = useResearchErrorToast();
  const identifier = getProjectIdentifierById(projectId);

  const { data, isLoading, mutate } = useSWR(["RESEARCH_MATRIX", workspaceSlug, projectId, questionId], () =>
    researchService.getResearchMatrix(workspaceSlug, projectId, questionId)
  );

  const cells = useMemo(() => {
    const map = new Map<string, TCellValue>();
    for (const cell of data?.cells ?? []) map.set(`${cell.evidence_id}:${cell.hypothesis_id}`, cell);
    return map;
  }, [data]);

  // ranking with the excluded evidence left out; the server ranking is the "all evidence" baseline
  const ranking = useMemo(() => {
    if (!data) return [];
    const validEvidenceIds = new Set(
      data.evidence.filter((item) => item.research_status === "valid").map((item) => item.id)
    );
    return rankHypotheses({
      hypothesisIds: data.hypotheses.map((item) => item.id),
      cells: data.cells,
      validEvidenceIds,
      excludedEvidenceIds: excludedIds,
    });
  }, [data, excludedIds]);
  const baselineRank = new Map(data?.hypotheses.map((item) => [item.id, item.rank]));
  const hypothesesById = new Map(data?.hypotheses.map((item) => [item.id, item]));

  const setCell = async (evidenceId: string, hypothesisId: string, value: TCellValue) => {
    const current = cells.get(`${evidenceId}:${hypothesisId}`);
    try {
      if (!value && current) {
        await removeResearchRelation(workspaceSlug, projectId, evidenceId, current.relation_type, hypothesisId);
      } else if (value && !current) {
        await createResearchRelation(
          workspaceSlug,
          projectId,
          evidenceId,
          value.relation_type,
          [hypothesisId],
          value.weight ?? undefined
        );
      } else if (value && current) {
        await updateResearchRelation(workspaceSlug, projectId, evidenceId, hypothesisId, {
          relation_type: value.relation_type,
          weight: value.weight ?? undefined,
        });
      }
      await mutate();
    } catch (error) {
      showError(error);
    }
  };

  const toggleExcluded = (evidenceId: string) =>
    setExcludedIds((current) => {
      const next = new Set(current);
      if (next.has(evidenceId)) next.delete(evidenceId);
      else next.add(evidenceId);
      return next;
    });

  const cellOptions: { label: string; value: TCellValue }[] = [
    ...(["supports", "opposes"] as const).flatMap((relation) =>
      RESEARCH_RELATION_WEIGHTS.map((weight) => ({
        label: `${t(RESEARCH_RELATION_I18N_LABEL[relation])} · ${t(RESEARCH_RELATION_WEIGHT_I18N_LABEL[weight])}`,
        value: { relation_type: relation, weight: weight as TResearchRelationWeight },
      }))
    ),
    { label: t("research.matrix.no_link"), value: undefined },
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size="xl">
        <DialogMain>
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>
                {t("research.matrix.title")}
                {data && (
                  <span className="font-normal ml-2 text-14 text-tertiary">
                    {identifier}-{data.question.sequence_id} {data.question.name}
                  </span>
                )}
              </DialogTitle>
            </DialogHeading>
          </DialogHeader>
          <DialogBody tabIndex={0}>
            {isLoading || !data ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : data.hypotheses.length === 0 ? (
              <p className="py-6 text-center text-13 text-tertiary">{t("research.matrix.empty")}</p>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-12 text-tertiary">{t("research.matrix.description")}</p>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-13">
                    <thead>
                      <tr>
                        <th className="w-64 border-b border-subtle p-2 text-left font-medium text-secondary">
                          {t("research.matrix.evidence")}
                        </th>
                        {ranking.map((score) => {
                          const hypothesis = hypothesesById.get(score.hypothesisId);
                          if (!hypothesis) return null;
                          const status = hypothesis.research_status
                            ? RESEARCH_STATUS_MAP[hypothesis.research_status]
                            : undefined;
                          const moved = baselineRank.get(score.hypothesisId) !== score.rank;
                          return (
                            <th
                              key={score.hypothesisId}
                              className="min-w-40 border-b border-subtle p-2 text-left align-bottom font-medium"
                            >
                              <div className="flex flex-col gap-1">
                                <span className={cn("text-11", moved ? "text-accent-primary" : "text-tertiary")}>
                                  #{score.rank}
                                  {moved && ` (${t("research.matrix.was")} #${baselineRank.get(score.hypothesisId)})`}
                                </span>
                                <span className="line-clamp-2 text-primary">
                                  {identifier}-{hypothesis.sequence_id} {hypothesis.name}
                                </span>
                                <span className="font-normal flex items-center gap-2 text-11 text-secondary">
                                  {status && (
                                    <span className="flex items-center gap-1">
                                      <ColorDot color={status.color} />
                                      {t(status.i18n_label)}
                                    </span>
                                  )}
                                  {hypothesis.needs_review && (
                                    <WarningTriangleOutline
                                      className="size-3 text-warning-primary"
                                      aria-label={t("research.needs_review")}
                                    />
                                  )}
                                </span>
                                <span className="font-normal text-11">
                                  <span className="text-danger-primary">
                                    {t("research.matrix.against")} {score.inconsistency}
                                  </span>{" "}
                                  ·{" "}
                                  <span className="text-success-primary">
                                    {t("research.matrix.for")} {score.support}
                                  </span>
                                </span>
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {data.evidence.map((evidence) => {
                        const isExcluded = excludedIds.has(evidence.id);
                        const isValid = evidence.research_status === "valid";
                        return (
                          <tr key={evidence.id} className={cn({ "opacity-50": isExcluded || !isValid })}>
                            <td className="border-b border-subtle p-2 align-top">
                              <div className="flex flex-col gap-1">
                                <span className="text-primary">
                                  {identifier}-{evidence.sequence_id} {evidence.name}
                                </span>
                                <span className="flex flex-wrap items-center gap-2 text-11 text-tertiary">
                                  {!isValid && <span>{t("research.statuses.invalidated")}</span>}
                                  {!evidence.diagnostic && (
                                    <span className="text-warning-primary">{t("research.matrix.not_diagnostic")}</span>
                                  )}
                                  <label className="flex cursor-pointer items-center gap-1">
                                    <input
                                      type="checkbox"
                                      checked={isExcluded}
                                      onChange={() => toggleExcluded(evidence.id)}
                                    />
                                    {t("research.matrix.what_if")}
                                  </label>
                                </span>
                              </div>
                            </td>
                            {ranking.map((score) => {
                              const cell = cells.get(`${evidence.id}:${score.hypothesisId}`);
                              const label = cell
                                ? `${cell.relation_type === "supports" ? "+" : "−"}${cell.weight ?? ""}`
                                : "—";
                              const className = cn(
                                "w-full rounded-sm px-2 py-1 text-center font-medium",
                                cell?.relation_type === "supports" && "bg-success-subtle text-success-primary",
                                cell?.relation_type === "opposes" && "bg-danger-subtle text-danger-primary",
                                !cell && "text-tertiary"
                              );
                              return (
                                <td key={score.hypothesisId} className="border-b border-subtle p-2 align-top">
                                  {canEdit ? (
                                    <Menu>
                                      <MenuTrigger
                                        aria-label={t("research.matrix.edit_cell")}
                                        render={
                                          <button type="button" className={cn(className, "hover:opacity-80")}>
                                            {label}
                                          </button>
                                        }
                                      />
                                      <MenuContent side="bottom" align="center">
                                        {cellOptions.map((option) => (
                                          <MenuItem
                                            key={option.label}
                                            label={option.label}
                                            onClick={() => void setCell(evidence.id, score.hypothesisId, option.value)}
                                          />
                                        ))}
                                      </MenuContent>
                                    </Menu>
                                  ) : (
                                    <div className={className}>{label}</div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {data.evidence.length === 0 && (
                  <p className="text-12 text-tertiary">{t("research.matrix.no_evidence")}</p>
                )}
                {excludedIds.size > 0 && (
                  <button
                    type="button"
                    className="self-start text-12 text-accent-primary hover:underline"
                    onClick={() => setExcludedIds(new Set())}
                  >
                    {t("research.matrix.include_all")}
                  </button>
                )}
              </div>
            )}
          </DialogBody>
        </DialogMain>
      </DialogContent>
    </Dialog>
  );
});
