import { forwardRef, type InputHTMLAttributes } from 'react';
import { X } from 'lucide-react';

import { cn } from '../../lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Opt-in clear affordance. When supplied *and* the field has a value, an X button
   * is rendered inside the trailing edge. Opt-in rather than automatic because it
   * makes no sense on every input (e.g. the numeric package-count stepper, which
   * must never be empty).
   */
  onClear?: () => void;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, onClear, ...props }, ref) => {
    // `value` is always controlled where onClear is used; String() guards the
    // number/readonly-array cases the DOM typing allows.
    const hasValue = props.value !== undefined && String(props.value).length > 0;
    const showClear = onClear !== undefined && hasValue && props.disabled !== true;

    const input = (
      <input
        ref={ref}
        className={cn(
          'flex h-11 w-full rounded-lg border-none bg-surface-sunken px-4 text-base text-ink shadow-inset placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
          // Keeps the text from running under the clear button. Reserved only when
          // the button is actually shown, so the field doesn't shift on first keypress
          // — the padding is applied for the whole lifetime of a clearable input.
          onClear !== undefined && 'pr-11',
          className
        )}
        {...props}
      />
    );

    if (onClear === undefined) return input;

    return (
      <div className="relative">
        {input}
        {showClear && (
          <button
            type="button"
            // mousedown default-prevented so clicking the X doesn't blur the field
            // first — that would close the suggestion dropdown and, in
            // AvailabilityView, collapse the location editor before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClear}
            aria-label="Eingabe löschen"
            data-testid="input-clear"
            className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-faint active:bg-surface active:text-ink"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';
