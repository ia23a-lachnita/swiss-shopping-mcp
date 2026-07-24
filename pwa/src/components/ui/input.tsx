import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-11 w-full rounded-lg border-none bg-surface-sunken px-4 text-base text-ink shadow-inset placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
