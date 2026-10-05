/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { WarningTriangleOutline } from "@makeplane/propel/icons";
import { Input, InputGroup } from "@makeplane/propel/components/input";
import { TextArea, TextAreaGroup } from "@makeplane/propel/components/text-area";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TIssueResearchDetailsPayload, TIssueServiceType, TResearchNodeType } from "@plane/types";
import { renderFormattedDate } from "@plane/utils";
// components
import { useResearchData, useResearchErrorToast } from "@/components/issues/research/use-research";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// local imports
import { ResearchLinks } from "./links";

type TTextField =
  | "statement"
  | "success_criteria"
  | "conclusion_html"
  | "repo_url"
  | "branch"
  | "commit_sha"
  | "artifact_url";

// Which detail fields each node type uses
const FIELDS_BY_TYPE: Record<TResearchNodeType, TTextField[]> = {
  question: ["statement", "conclusion_html"],
  hypothesis: ["statement", "success_criteria", "conclusion_html"],
  experiment: ["statement", "conclusion_html", "repo_url", "branch"],
  evidence: ["statement", "conclusion_html", "repo_url", "branch", "commit_sha", "artifact_url"],
};
const MULTILINE_FIELDS = new Set<TTextField>(["statement", "success_criteria", "conclusion_html"]);
const REPRODUCIBILITY_FIELDS = new Set<TTextField>(["repo_url", "branch", "commit_sha", "artifact_url"]);

// The conclusion is stored as HTML; edit it as plain paragraphs
const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textToHtml = (text: string) =>
  text.trim()
    ? text
        .split(/\n+/)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join("")
    : "<p></p>";
const htmlToText = (html: string | undefined) => {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(html.replace(/<\/p>\s*<p>/g, "</p>\n<p>"), "text/html");
  return doc.body.textContent ?? "";
};

type TFieldProps = {
  label: string;
  placeholder?: string;
  multiline: boolean;
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
};

export function ResearchTextField(props: TFieldProps) {
  const { label, placeholder, multiline, value, disabled, onSave } = props;
  // the parent remounts this field (key={value}) when the stored value changes
  const [draft, setDraft] = useState(value);
  const save = () => {
    if (draft !== value) onSave(draft);
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-12 text-tertiary">{label}</span>
      {multiline ? (
        <TextAreaGroup resize="none">
          <TextArea
            size="md"
            surface="field"
            autoResize
            maxRows={8}
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
          />
        </TextAreaGroup>
      ) : (
        <InputGroup size="md">
          <Input
            size="md"
            type="text"
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
          />
        </InputGroup>
      )}
    </label>
  );
}

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled: boolean;
  issueServiceType: TIssueServiceType;
};

export const ResearchCollapsibleContent = observer(function ResearchCollapsibleContent(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled, issueServiceType } = props;
  const { t } = useTranslation();
  const {
    issue: { getIssueById },
    research: { getDetails, updateDetails },
  } = useIssueDetail(issueServiceType);
  const showError = useResearchErrorToast();
  useResearchData(workspaceSlug, projectId, issueId, issueServiceType);
  // derived values
  const issue = getIssueById(issueId);
  const details = getDetails(issueId);
  const researchType = issue?.research_type;

  if (!issue || !researchType) return null;

  const fields = FIELDS_BY_TYPE[researchType];
  const save = (data: TIssueResearchDetailsPayload) =>
    updateDetails(workspaceSlug, projectId, issueId, data).catch(showError);

  const fieldValue = (field: TTextField) =>
    field === "conclusion_html" ? htmlToText(details?.conclusion_html) : (details?.[field] ?? "");

  const renderField = (field: TTextField) => (
    <ResearchTextField
      key={`${field}:${fieldValue(field)}`}
      label={t(`research.fields.${field === "conclusion_html" ? "conclusion" : field}`)}
      placeholder={
        field === "statement" || field === "success_criteria" || field === "conclusion_html"
          ? t(`research.placeholders.${field === "conclusion_html" ? "conclusion" : field}`)
          : undefined
      }
      multiline={MULTILINE_FIELDS.has(field)}
      value={fieldValue(field)}
      disabled={disabled}
      onSave={(value) => void save({ [field]: field === "conclusion_html" ? textToHtml(value) : value.trim() })}
    />
  );

  const reproducibilityFields = fields.filter((field) => REPRODUCIBILITY_FIELDS.has(field));

  return (
    <div className="flex flex-col gap-4 py-2">
      {issue.needs_review && (
        <div className="flex items-start gap-2 rounded-md bg-warning-subtle px-3 py-2 text-13 text-warning-primary">
          <WarningTriangleOutline className="mt-0.5 size-4 flex-shrink-0" />
          <span>{t("research.verdict.needs_review_hint")}</span>
        </div>
      )}
      {details?.verdict_at && (
        <p className="text-12 text-tertiary">
          {t("research.verdict.recorded", { date: renderFormattedDate(details.verdict_at) ?? "" })}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {fields.flatMap((field) => (REPRODUCIBILITY_FIELDS.has(field) ? [] : [renderField(field)]))}
        {researchType === "hypothesis" && (
          <ResearchTextField
            key={`confidence:${details?.confidence ?? ""}`}
            label={t("research.fields.confidence")}
            multiline={false}
            value={details?.confidence != null ? String(details.confidence) : ""}
            disabled={disabled}
            onSave={(value) => {
              const confidence = value.trim() === "" ? null : Math.round(Number(value));
              if (confidence !== null && (Number.isNaN(confidence) || confidence < 0 || confidence > 100)) return;
              void save({ confidence });
            }}
          />
        )}
      </div>

      {reproducibilityFields.length > 0 && (
        <div className="flex flex-col gap-3">
          <span className="text-13 font-medium text-secondary">{t("research.reproducibility.title")}</span>
          {researchType === "evidence" && details && !details.commit_sha && (
            <p className="text-12 text-tertiary">{t("research.reproducibility.missing_commit")}</p>
          )}
          {reproducibilityFields.map(renderField)}
        </div>
      )}

      <ResearchLinks
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        disabled={disabled}
        issueServiceType={issueServiceType}
      />
    </div>
  );
});
