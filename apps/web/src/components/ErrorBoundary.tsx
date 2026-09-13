import { staff } from "@/i18n/staff";
import React, { Component, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      // This boundary is outside LanguageProvider. Public/kiosk surfaces keep VI.
      const { hostname, pathname, search } = window.location;
      const excluded = hostname === "dathang.banhmique.vn" || hostname === "baocao.banhmique.vn"
        || /^\/(dealer|kho|auth|trace|recover)(\/|$)/.test(pathname) || search.includes("recover=1");
      let language: "en" | "vi" = "vi";
      try {
        // Accessing the storage property itself can throw in restricted browsers.
        if (!excluded && window.localStorage.getItem("app-language") === "en") language = "en";
      } catch {
        // Recovery UI must still render when browser storage is unavailable.
      }
      const s = staff[language];
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="max-w-md w-full text-center space-y-6">
            <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-destructive" />
            </div>
            
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-foreground">
                {s.unexpected_error}
              </h1>
              <p className="text-muted-foreground">
                {s.unexpected_error_help}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button onClick={this.handleRetry} variant="outline">
                {s.try_again}
              </Button>
              <Button onClick={this.handleReload} className="gap-2">
                <RefreshCw className="w-4 h-4" />
                {s.reload_page}
              </Button>
            </div>

            {/* Show error details in development */}
            {import.meta.env.DEV && this.state.error && (
              <details className="mt-6 text-left p-4 bg-muted rounded-lg overflow-auto max-h-60">
                <summary className="cursor-pointer font-medium text-sm text-muted-foreground mb-2">
                  {s.developer_error_details}
                </summary>
                <pre className="text-xs text-destructive whitespace-pre-wrap break-words">
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
