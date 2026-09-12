import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppRoutes } from '@/components/AppRoutes';
import { Toaster } from '@/components/ui/sonner';
import { Toaster as ToastMessages } from '@/components/ui/toaster';
import { SessionRecoveryOverlay } from '@/components/SessionRecoveryOverlay';
import '@/index.css';
import ErrorBoundary from '@/components/ErrorBoundary';
import { StaffUiProvider } from '@/contexts/StaffUiContext';
import { Pagination, PaginationContent, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
function ThrowFixture() { if (!(window as unknown as { __fixtureRecovered: boolean }).__fixtureRecovered) throw new Error("Synthetic render failure"); return <p>Recovered fixture</p>; }
function Fixture() {
  const { setLanguage } = useLanguage();
  if(location.search.includes('crash=1')) return <ErrorBoundary><ThrowFixture /></ErrorBoundary>;
  // Allows a language update while a modal correctly makes the header inert.
  (window as unknown as { __fixtureSetLanguage: typeof setLanguage }).__fixtureSetLanguage = setLanguage;
  return <><AppRoutes />{location.search.includes("pagination=1") && <StaffUiProvider><Pagination><PaginationContent><PaginationPrevious href="#previous" /><PaginationNext href="#next" /></PaginationContent></Pagination></StaffUiProvider>}{location.search.includes("crash=1") && <ErrorBoundary><ThrowFixture /></ErrorBoundary>}<Toaster /><ToastMessages />{location.search.includes('recovery=1') && <SessionRecoveryOverlay onRetry={() => undefined} />}</>;
}
createRoot(document.getElementById('root')!).render(
  location.search.includes("crash=1") ? <ErrorBoundary><ThrowFixture /></ErrorBoundary> : <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
    <LanguageProvider><TooltipProvider><BrowserRouter><Fixture /></BrowserRouter></TooltipProvider></LanguageProvider>
  </QueryClientProvider>,
);
