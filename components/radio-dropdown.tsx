import { cn } from '@/lib/utils';

/** Native select shared by the popup/options setting rows. */
export function RadioDropdown<T extends string>({
  value,
  onChange,
  options,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [value: T, label: string][];
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        'h-8 min-w-24 rounded border-2 bg-input px-3 py-1 text-sm shadow-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
        className,
      )}
    >
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  );
}
