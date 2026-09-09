import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';
import { StaffUiProvider } from '@/contexts/StaffUiContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import Index from '@/pages/Index';
import SkuCostsProducts from '@/pages/SkuCostsProducts';
import SkuCostsIngredients from '@/pages/SkuCostsIngredients';
import SkuCostsEmployees from '@/pages/SkuCostsEmployees';
import SkuCostsOverhead from '@/pages/SkuCostsOverhead';
import '@/index.css';
const pages = {index:Index,products:SkuCostsProducts,ingredients:SkuCostsIngredients,employees:SkuCostsEmployees,overhead:SkuCostsOverhead};
function Fixture(){
 const {setLanguage}=useLanguage();
 (window as unknown as {__setLanguage:typeof setLanguage}).__setLanguage=setLanguage;
 const Page=pages[location.pathname.slice(1) as keyof typeof pages]||Index;
 return <><nav><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav><Page/><Toaster/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}})}><LanguageProvider><StaffUiProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></StaffUiProvider></LanguageProvider></QueryClientProvider>);
