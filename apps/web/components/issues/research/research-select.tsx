/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { Select } from "@plane/blocks/select";
import type { SelectVariant } from "@plane/blocks/select";

export type TResearchSelectOption = { key: string; label: string; color?: string; hint?: string };

export const ColorDot = ({ color }: { color?: string }) => (
  <span className="size-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color ?? "transparent" }} />
);

const labelOf = (option: TResearchSelectOption) => (option.hint ? `${option.label} · ${option.hint}` : option.label);

type TResearchSelectProps = {
  options: TResearchSelectOption[];
  value: string | null | undefined;
  placeholder: string;
  disabled?: boolean;
  variant?: SelectVariant;
  isOptionDisabled?: (option: TResearchSelectOption) => boolean;
  onChange: (key: string) => void;
};

export function ResearchSelect(props: TResearchSelectProps) {
  const {
    options,
    value,
    placeholder,
    disabled = false,
    variant = "select-ghost-md",
    isOptionDisabled,
    onChange,
  } = props;
  const selected = options.find((option) => option.key === value) ?? null;

  return (
    <Select<TResearchSelectOption>
      getValues={() => options}
      value={selected}
      onChange={(key) => key && key !== value && onChange(key)}
      disabled={disabled}
      placeholder={placeholder}
      showSearch={false}
      pinSelected={false}
      getOptionValue={(option) => option.key}
      getOptionLabel={labelOf}
      getOptionIcon={(option) => <ColorDot color={option.color} />}
      getOptionDisabled={isOptionDisabled}
    >
      <Select.Trigger<TResearchSelectOption>
        disabled={disabled}
        variant={variant}
        prependIcon={(items) => (items[0]?.color ? <ColorDot color={items[0].color} /> : undefined)}
        label={(items) => items[0]?.label ?? placeholder}
      >
        {(items) => <span className="min-w-0 grow truncate text-left">{items[0]?.label ?? placeholder}</span>}
      </Select.Trigger>
    </Select>
  );
}
