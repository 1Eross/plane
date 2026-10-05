/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { WarningTriangleOutline } from "@makeplane/propel/icons";
// plane imports
import { RESEARCH_NODE_TYPE_MAP, RESEARCH_STATUS_MAP } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TIssue } from "@plane/types";

type Props = {
  issue: TIssue;
  onClose: () => void;
  onChange: (issue: TIssue, data: Partial<TIssue>, updates: any) => void;
  disabled: boolean;
};

/** Research type and status of a work item; they are edited in the work item sidebar, where the research rules apply. */
export const SpreadsheetResearchColumn = observer(function SpreadsheetResearchColumn(props: Props) {
  const { issue } = props;
  const { t } = useTranslation();
  const nodeType = issue.research_type ? RESEARCH_NODE_TYPE_MAP[issue.research_type] : undefined;
  const status = issue.research_status ? RESEARCH_STATUS_MAP[issue.research_status] : undefined;

  return (
    <div className="flex h-11 items-center gap-2 border-b-[0.5px] border-subtle px-2.5 text-13">
      {nodeType ? (
        <>
          <span className="font-medium" style={{ color: nodeType.color }}>
            {t(nodeType.i18n_label)}
          </span>
          {status && (
            <span className="flex items-center gap-1 text-secondary">
              <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
              {t(status.i18n_label)}
            </span>
          )}
          {issue.needs_review && (
            <WarningTriangleOutline className="size-3.5 text-warning-primary" aria-label={t("research.needs_review")} />
          )}
        </>
      ) : (
        <span className="text-placeholder">—</span>
      )}
    </div>
  );
});
