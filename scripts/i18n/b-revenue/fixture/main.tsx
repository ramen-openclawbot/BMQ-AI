import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {StaffUiProvider} from '@/contexts/StaffUiContext';
import {LanguageProvider,useLanguage} from '@/contexts/LanguageContext';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Toaster} from '@/components/ui/toaster';
import {Toaster as Sonner} from '@/components/ui/sonner';
import RevenueManagementDashboard from '@/pages/RevenueManagementDashboard';
import RevenueSourceDetail from '@/pages/RevenueSourceDetail';
import RevenueDailyReview from '@/pages/RevenueDailyReview';
import FinanceRevenueControl from '@/pages/FinanceRevenueControl';
import PointRevenueManagement from '@/pages/PointRevenueManagement';
import '@/index.css';
const pages={dashboard:RevenueManagementDashboard,source:RevenueSourceDetail,daily:RevenueDailyReview,parse:FinanceRevenueControl,point:PointRevenueManagement};
function Fixture(){const{setLanguage}=useLanguage();const Page=pages[new URLSearchParams(location.search).get('page')||'daily'];return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav><Page/><Toaster/><Sonner/></>}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}})}><LanguageProvider><StaffUiProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></StaffUiProvider></LanguageProvider></QueryClientProvider>);
