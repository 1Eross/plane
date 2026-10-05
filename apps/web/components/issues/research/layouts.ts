/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { EIssueLayoutTypes } from "@plane/types";

/** Adds the research graph layout when the project enabled the research graph feature. */
export const withResearchGraphLayout = (
  layouts: EIssueLayoutTypes[],
  project: { research_graph_view?: boolean } | undefined
): EIssueLayoutTypes[] => (project?.research_graph_view ? [...layouts, EIssueLayoutTypes.RESEARCH_GRAPH] : layouts);
