import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LanguageProvider,useLanguage} from '@/contexts/LanguageContext';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Toaster as Sonner} from '@/components/ui/sonner';
import Attendance from '@/pages/AttendanceManagement';
import Payroll from '@/pages/PayrollManagement';
import Settings from '@/pages/Settings';
import Users from '@/pages/UserManagement';
import System from '@/pages/SystemManagement';
import '@/index.css';
function Fixture(){const {setLanguage}=useLanguage(); (window as any).__setLanguage=setLanguage; const Page=({attendance:Attendance,payroll:Payroll,settings:Settings,users:Users,system:System})[location.pathname.slice(1)]||Settings;return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav><Page/><Sonner/></>;}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}})}><LanguageProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></LanguageProvider></QueryClientProvider>);
