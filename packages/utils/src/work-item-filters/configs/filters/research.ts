/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { RESEARCH_NODE_TYPES, RESEARCH_STATUSES_BY_TYPE } from "@plane/constants";
import type { TFilterProperty, TResearchNodeType, TResearchStatus, TSupportedOperators } from "@plane/types";
import { COLLECTION_OPERATOR, EQUALITY_OPERATOR } from "@plane/types";
// local imports
import type { IFilterIconConfig, TCreateFilterConfig, TCreateFilterConfigParams } from "../../../rich-filters";
import {
  createFilterConfig,
  createOperatorConfigEntry,
  getMultiSelectConfig,
  getSingleSelectConfig,
} from "../../../rich-filters";

const toTitle = (key: string) => (key.charAt(0).toUpperCase() + key.slice(1)).replace(/_/g, " ");

const RESEARCH_TYPE_ITEMS = RESEARCH_NODE_TYPES.map((key) => ({ key, title: toTitle(key) }));

// Every status once, in node type order
const RESEARCH_STATUS_ITEMS = [...new Set(Object.values(RESEARCH_STATUSES_BY_TYPE).flat())].map((key) => ({
  key,
  title: toTitle(key),
}));

// ------------ Research type filter ------------

export type TCreateResearchTypeFilterParams = TCreateFilterConfigParams & IFilterIconConfig<TResearchNodeType>;

export const getResearchTypeMultiSelectConfig = (
  params: TCreateResearchTypeFilterParams,
  singleValueOperator: TSupportedOperators
) =>
  getMultiSelectConfig<{ key: TResearchNodeType; title: string }, TResearchNodeType, TResearchNodeType>(
    {
      items: RESEARCH_TYPE_ITEMS,
      getId: (item) => item.key,
      getLabel: (item) => item.title,
      getValue: (item) => item.key,
      getIconData: (item) => item.key,
    },
    { singleValueOperator, ...params },
    { getOptionIcon: params.getOptionIcon }
  );

export const getResearchTypeFilterConfig =
  <P extends TFilterProperty>(key: P): TCreateFilterConfig<P, TCreateResearchTypeFilterParams> =>
  (params: TCreateResearchTypeFilterParams) =>
    createFilterConfig<P>({
      id: key,
      label: "Research type",
      ...params,
      icon: params.filterIcon,
      supportedOperatorConfigsMap: new Map([
        createOperatorConfigEntry(COLLECTION_OPERATOR.IN, params, (updatedParams) =>
          getResearchTypeMultiSelectConfig(updatedParams, EQUALITY_OPERATOR.EXACT)
        ),
      ]),
    });

// ------------ Research status filter ------------

export type TCreateResearchStatusFilterParams = TCreateFilterConfigParams & IFilterIconConfig<TResearchStatus>;

export const getResearchStatusMultiSelectConfig = (
  params: TCreateResearchStatusFilterParams,
  singleValueOperator: TSupportedOperators
) =>
  getMultiSelectConfig<{ key: TResearchStatus; title: string }, TResearchStatus, TResearchStatus>(
    {
      items: RESEARCH_STATUS_ITEMS,
      getId: (item) => item.key,
      getLabel: (item) => item.title,
      getValue: (item) => item.key,
      getIconData: (item) => item.key,
    },
    { singleValueOperator, ...params },
    { getOptionIcon: params.getOptionIcon }
  );

export const getResearchStatusFilterConfig =
  <P extends TFilterProperty>(key: P): TCreateFilterConfig<P, TCreateResearchStatusFilterParams> =>
  (params: TCreateResearchStatusFilterParams) =>
    createFilterConfig<P>({
      id: key,
      label: "Research status",
      ...params,
      icon: params.filterIcon,
      supportedOperatorConfigsMap: new Map([
        createOperatorConfigEntry(COLLECTION_OPERATOR.IN, params, (updatedParams) =>
          getResearchStatusMultiSelectConfig(updatedParams, EQUALITY_OPERATOR.EXACT)
        ),
      ]),
    });

// ------------ Needs review filter ------------

export type TCreateNeedsReviewFilterParams = TCreateFilterConfigParams & IFilterIconConfig<boolean>;

export const getNeedsReviewFilterConfig =
  <P extends TFilterProperty>(key: P): TCreateFilterConfig<P, TCreateNeedsReviewFilterParams> =>
  (params: TCreateNeedsReviewFilterParams) =>
    createFilterConfig<P>({
      id: key,
      label: "Needs review",
      ...params,
      icon: params.filterIcon,
      supportedOperatorConfigsMap: new Map([
        createOperatorConfigEntry(EQUALITY_OPERATOR.EXACT, params, (updatedParams) =>
          getSingleSelectConfig<{ key: boolean; title: string }, boolean, boolean>(
            {
              items: [
                { key: true, title: "Yes" },
                { key: false, title: "No" },
              ],
              getId: (item) => String(item.key),
              getLabel: (item) => item.title,
              getValue: (item) => item.key,
              getIconData: (item) => item.key,
            },
            { ...updatedParams },
            { getOptionIcon: updatedParams.getOptionIcon }
          )
        ),
      ]),
    });
