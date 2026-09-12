import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import RevenueDailyReview from '@/pages/RevenueDailyReview';
import PayablesManagement from '@/pages/PayablesManagement';
import { Toaster as Sonner } from '@/components/ui/sonner';
import '@/index.css';
function Fixture() {
  const { setLanguage } = useLanguage();
  (window as unknown as { __fixtureSetLanguage: typeof setLanguage }).__fixtureSetLanguage = setLanguage;
  return <><nav aria-label="Fixture language"><button onClick={() => setLanguage('vi')}>VI</button><button onClick={() => setLanguage('en')}>EN</button></nav>{location.pathname === '/finance-control/payables' ? <PayablesManagement /> : <RevenueDailyReview />}<Toaster /><Sonner /></>;
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
    <LanguageProvider><TooltipProvider><BrowserRouter><Fixture /></BrowserRouter></TooltipProvider></LanguageProvider>
  </QueryClientProvider>,
);
