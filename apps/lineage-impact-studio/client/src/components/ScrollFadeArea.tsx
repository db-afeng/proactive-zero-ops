import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';

import { cn } from '@/lib/utils';

interface ScrollEdges {
  before: boolean;
  after: boolean;
}

export function ScrollFadeArea({
  children,
  className,
  viewportClassName,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollEndTimer = useRef<number | undefined>(undefined);
  const [edges, setEdges] = useState<ScrollEdges>({ before: false, after: false });
  const [scrolling, setScrolling] = useState(false);

  const updateEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const next = {
      before: viewport.scrollTop > 1,
      after: remaining > 1,
    };
    setEdges((current) => (current.before === next.before && current.after === next.after ? current : next));
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;

    updateEdges();
    const resizeObserver = new ResizeObserver(updateEdges);
    resizeObserver.observe(viewport);
    const mutationObserver = new MutationObserver(updateEdges);
    mutationObserver.observe(viewport, { childList: true, subtree: true, characterData: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (scrollEndTimer.current !== undefined) window.clearTimeout(scrollEndTimer.current);
    };
  }, [updateEdges]);

  function handleScroll(_event: UIEvent<HTMLDivElement>) {
    updateEdges();
    setScrolling(true);
    if (scrollEndTimer.current !== undefined) window.clearTimeout(scrollEndTimer.current);
    scrollEndTimer.current = window.setTimeout(() => setScrolling(false), 700);
  }

  return (
    <div className={cn('scroll-fade-frame relative min-h-0', className)}>
      <div
        ref={viewportRef}
        className={cn('subtle-scroll-y h-full overflow-y-auto', viewportClassName)}
        aria-label={ariaLabel}
        data-scrolling={scrolling ? 'true' : 'false'}
        data-scroll-before={edges.before ? 'true' : 'false'}
        data-scroll-after={edges.after ? 'true' : 'false'}
        data-testid={testId}
        onScroll={handleScroll}
      >
        {children}
      </div>
      {edges.before ? <div className="scroll-fade-edge scroll-fade-edge-before" aria-hidden="true" /> : null}
      {edges.after ? <div className="scroll-fade-edge scroll-fade-edge-after" aria-hidden="true" /> : null}
    </div>
  );
}
