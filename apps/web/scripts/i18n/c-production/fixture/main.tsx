import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import Planning from '@/pages/ProductionPlanning';
import Inventory from '@/pages/Q7MaterialInventory';
import Materials from '@/pages/material-master/MaterialMasterAdmin';
import System from '@/pages/material-master/MaterialMasterSystemStatus';
import Products from '@/pages/ProductionProducts';
import Shifts from '@/pages/ProductionShifts';
import QA from '@/pages/QAInspection';
import '@/index.css';
const pages={planning:Planning,inventory:Inventory,materials:Materials,system:System,products:Products,shifts:Shifts,qa:QA};
function Fixture(){const {setLanguage}=useLanguage();const Page=pages[location.pathname.slice(1) as keyof typeof pages]||Products;return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav><Page/><Toaster/><Sonner/></>;}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}})}><LanguageProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></LanguageProvider></QueryClientProvider>);
