/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { WorkgraphOutline } from "@makeplane/propel/icons";
// plane imports
import { RESEARCH_NODE_TYPE_MAP, RESEARCH_STATUS_MAP } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TResearchNodeType, TResearchStatus } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// components
import { IssueActivityBlockComponent } from "./helpers/activity-block";
import { IssueLink } from "./helpers/issue-link";

type TIssueResearchActivity = { activityId: string; showIssue?: boolean; ends: "top" | "bottom" | undefined };

export const IssueResearchActivity = observer(function IssueResearchActivity(props: TIssueResearchActivity) {
  const { activityId, showIssue = true, ends } = props;
  // hooks
  const {
    activity: { getActivityById },
  } = useIssueDetail();
  const { t } = useTranslation();

  const activity = getActivityById(activityId);

  if (!activity) return <></>;

  const isType = activity.field === "research_type";
  const value = activity.new_value;
  const valueLabel = !value
    ? ""
    : isType
      ? t(RESEARCH_NODE_TYPE_MAP[value as TResearchNodeType]?.i18n_label ?? value)
      : t(RESEARCH_STATUS_MAP[value as TResearchStatus]?.i18n_label ?? value);

  return (
    <IssueActivityBlockComponent
      icon={<WorkgraphOutline className="h-3.5 w-3.5 text-secondary" aria-hidden="true" />}
      activityId={activityId}
      ends={ends}
    >
      <>
        {valueLabel ? (
          <>
            set the research {isType ? "type" : "status"} to{" "}
            <span className="font-medium text-primary">{valueLabel}</span>
          </>
        ) : (
          <>cleared the research {isType ? "type" : "status"}</>
        )}
        {showIssue ? ` for ` : ``}
        {showIssue && <IssueLink activityId={activityId} />}.
      </>
    </IssueActivityBlockComponent>
  );
});
