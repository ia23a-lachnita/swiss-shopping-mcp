import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';

import { cn } from '../../lib/utils';
import { Input } from './input';

export interface SuggestInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  /** Should be a stable (module-level or memoized) function — re-created references retrigger the debounce. */
  fetchSuggestions: (query: string) => Promise<string[]>;
  /** Called in addition to onChange when a suggestion is picked (click or Enter). Named to avoid colliding with the native `onSelect` (text-selection) DOM event. */
  onSuggestionSelect?: (value: string) => void;
  minLength?: number;
  debounceMs?: number;
  /** Renders a clear (X) button while the field is non-empty. */
  clearable?: boolean;
}

/** Debounced autocomplete dropdown over `Input`, backed by a real (non-hardcoded) suggestion source. */
export function SuggestInput({
  value,
  onChange,
  fetchSuggestions,
  onSuggestionSelect,
  minLength = 2,
  debounceMs = 250,
  clearable = false,
  className,
  onBlur,
  onFocus,
  ...inputProps
}: SuggestInputProps): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const justSelectedRef = useRef(false);

  useEffect(() => {
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      fetchSuggestions(trimmed)
        .then((results) => {
          if (requestIdRef.current !== requestId) return;
          setSuggestions(results);
          setOpen(results.length > 0);
          setActiveIndex(-1);
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
          setSuggestions([]);
          setOpen(false);
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [value, minLength, debounceMs, fetchSuggestions]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function selectSuggestion(suggestion: string): void {
    justSelectedRef.current = true;
    onChange(suggestion);
    onSuggestionSelect?.(suggestion);
    setOpen(false);
    setSuggestions([]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      selectSuggestion(suggestions[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onClear={
          clearable
            ? () => {
                onChange('');
                setSuggestions([]);
                setOpen(false);
                // Clearing is nearly always a prelude to retyping, so keep focus
                // (and, on mobile, the keyboard) rather than dismissing both.
                inputRef.current?.focus();
              }
            : undefined
        }
        onKeyDown={handleKeyDown}
        // Composed rather than spread from inputProps: a caller-supplied
        // handler would otherwise replace these and leave the dropdown stuck
        // open, since {...inputProps} is applied last.
        onFocus={(event) => {
          if (suggestions.length > 0) setOpen(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setOpen(false);
          onBlur?.(event);
        }}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        className={className}
        {...inputProps}
      />
      {open && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-lg bg-surface py-1 shadow-card">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectSuggestion(suggestion)}
                className={cn(
                  'block w-full truncate px-4 py-2 text-left text-sm',
                  index === activeIndex ? 'bg-brand text-brand-ink' : 'text-ink hover:bg-surface-sunken'
                )}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
