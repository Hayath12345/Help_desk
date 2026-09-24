'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useState } from 'react';
import { DirectionProvider } from '@/components/ui/direction';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { transitions } from '@/lib/motion';

export function AppProviders({ dir, children }: { dir: 'ltr' | 'rtl'; children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* reducedMotion="user": transform/layout animations are skipped when the OS asks for less motion. */}
      <MotionConfig reducedMotion="user" transition={transitions.base}>
        <DirectionProvider dir={dir}>
          <TooltipProvider delayDuration={300}>
            {children}
            <Toaster position="bottom-center" dir={dir} />
          </TooltipProvider>
        </DirectionProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
