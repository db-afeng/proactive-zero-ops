import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@databricks/appkit-ui/react';
import { GitPullRequestArrow } from 'lucide-react';
import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { AssessmentPage } from './pages/assessment/AssessmentPage';

const router = createBrowserRouter([
  { path: '/', element: <StartPage /> },
  { path: '/assessments/:reference', element: <AssessmentPage /> },
  { path: '*', element: <StartPage /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

function StartPage() {
  useEffect(() => {
    document.title = 'Lineage Impact Studio';
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3 md:px-6">
        <p className="text-sm font-semibold">Lineage Impact Studio</p>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <Empty className="max-w-lg border-0">
          <EmptyHeader>
            <EmptyMedia>
              <GitPullRequestArrow className="size-5 text-muted-foreground" aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Open an assessment from its pull request</EmptyTitle>
            <EmptyDescription>
              Use the authorized impact link in the GitHub check comment. Assessment references are intentionally not
              searchable here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    </div>
  );
}
