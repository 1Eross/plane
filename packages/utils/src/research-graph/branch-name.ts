/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TResearchNodeType } from "@plane/types";

// Same convention as .claude/skills/branch-name: <type>/<work-item-id>-<short-description>

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  ґ: "g",
  д: "d",
  е: "e",
  ё: "e",
  є: "ye",
  ж: "zh",
  з: "z",
  и: "i",
  і: "i",
  ї: "yi",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const FILLER_WORDS = new Set(["a", "an", "the", "for", "of", "to", "and", "in", "on", "with"]);
const MAX_WORDS = 5;
const MAX_SLUG_LENGTH = 48;

export const transliterate = (value: string): string =>
  [...value.toLowerCase()].map((char) => CYRILLIC_TO_LATIN[char] ?? char).join("");

export const slugifyBranchDescription = (name: string): string => {
  const words = transliterate(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !FILLER_WORDS.has(word))
    .slice(0, MAX_WORDS);

  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  return slug || "work";
};

export const getResearchBranchType = (researchType: TResearchNodeType | null | undefined): string =>
  researchType === "experiment" ? "exp" : "feat";

/** e.g. { projectIdentifier: "RND", sequenceId: 57, name: "Прогрев кэша", researchType: "experiment" } -> "exp/rnd-57-progrev-kesha" */
export const getResearchBranchName = ({
  projectIdentifier,
  sequenceId,
  name,
  researchType,
}: {
  projectIdentifier: string;
  sequenceId: number;
  name: string;
  researchType?: TResearchNodeType | null;
}): string =>
  `${getResearchBranchType(researchType)}/${projectIdentifier.toLowerCase()}-${sequenceId}-${slugifyBranchDescription(name)}`;
