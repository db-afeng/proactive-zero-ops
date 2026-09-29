import { ResourceStatusIndicator, ResourceStatusProvider, TooltipProvider } from '@databricks/appkit-ui/react';
import { ThemeProvider } from 'next-themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <ErrorBoundary>
        {/*
         * Surfaces resource readiness (e.g. SQL warehouse cold-starts) as a
         * single sonner toast across the whole tree. Both are no-ops when
         * nothing's pending; remove them to render the aggregate yourself
         * via useResourceStatus(). Apps that already mount their own
         * <Toaster /> can swap the indicator for useResourceStatusToaster().
         */}
        <ResourceStatusProvider>
          <ResourceStatusIndicator />
          <TooltipProvider>
            <App />
          </TooltipProvider>
        </ResourceStatusProvider>
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>
);
