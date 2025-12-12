import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-[var(--background-color-th_primary)] text-[var(--text-color-th_primary)] border border-[var(--border-color-th_primary)] hover:opacity-90',
        primary: 'bg-[var(--background-color-th_primary)] text-[var(--text-color-th_primary)] border border-[var(--border-color-th_primary)] hover:opacity-90',
        secondary: 'bg-[var(--background-color-th_secondary)] text-[var(--text-color-th_secondary)] border border-[var(--border-color-th_secondary)] hover:opacity-90',
        distinct: 'bg-[var(--background-color-th_primary)] text-[var(--text-color-th_primary)] border border-[var(--border-color-th_primary)] hover:opacity-90', // Example mapping
        positive: 'bg-[var(--background-color-th_positive)] text-[var(--text-color-th_positive)] border border-[var(--border-color-th_positive)] hover:opacity-90',
        negative: 'bg-[var(--background-color-th_negative)] text-[var(--text-color-th_negative)] border border-[var(--border-color-th_negative)] hover:opacity-90',
        'negative-secondary': 'bg-[var(--background-color-th_negative-secondary)] text-[var(--text-color-th_negative-secondary)] border border-[var(--border-color-th_negative-secondary)] hover:opacity-90',
        strong: 'bg-[var(--background-color-th_strong)] text-[var(--text-color-th_strong)] border border-[var(--border-color-th_strong)] hover:opacity-90',
        warning: 'bg-[var(--background-color-th_warning)] text-[var(--text-color-th_warning)] border border-[var(--border-color-th_warning)] hover:opacity-90',
        content: 'bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',

        // Backward compatibility mappings
        destructive: 'bg-[var(--background-color-th_negative)] text-[var(--text-color-th_negative)] border border-[var(--border-color-th_negative)] hover:opacity-90',
        outline: 'border border-[var(--border-color-th_secondary)] bg-transparent hover:bg-[var(--background-color-th_secondary)] hover:text-[var(--text-color-th_secondary)]',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        success: 'bg-[var(--background-color-th_positive)] text-[var(--text-color-th_positive)] border border-[var(--border-color-th_positive)] hover:opacity-90',
      },
      size: {
        default: 'h-[38px] px-4 rounded-[8px] text-[15px]', // Medium (8px)
        medium: 'h-[38px] px-4 rounded-[8px] text-[15px]',
        sm: 'h-[28px] px-2 rounded-[5px] text-[13px]', // Small (5px)
        small: 'h-[28px] px-2 rounded-[5px] text-[13px]',
        lg: 'h-[42px] px-5 rounded-[14px] text-[16px]', // Large (14px)
        large: 'h-[42px] px-5 rounded-[14px] text-[16px]',
        icon: 'h-[38px] w-[38px] rounded-[8px]',
        'icon-sm': 'h-[28px] w-[28px] rounded-[5px]',
        'icon-lg': 'h-[42px] w-[42px] rounded-[14px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
