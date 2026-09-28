import { Component } from 'react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@databricks/appkit-ui/react';
import { AlertCircle, RotateCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
    };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center bg-background px-4 py-16 text-foreground">
          <main className="mx-auto w-full max-w-2xl">
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Lineage Impact Studio stopped unexpectedly</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>No assessment details were written to the browser console.</p>
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                  <RotateCw aria-hidden="true" />
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          </main>
        </div>
      );
    }

    return this.props.children;
  }
}
