import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LanguageProvider,useLanguage} from '@/contexts/LanguageContext';
import {StaffUiProvider} from '@/contexts/StaffUiContext';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Toaster} from '@/components/ui/toaster';
import {Toaster as Sonner} from '@/components/ui/sonner';
import FinanceControl from '@/pages/FinanceControl';
import NppDebtManagement from '@/pages/NppDebtManagement';
import PayablesManagement from '@/pages/PayablesManagement';
import {AddPaymentRequestDialog} from '@/components/dialogs/AddPaymentRequestDialog';
import '@/index.css';
function Fixture(){const {setLanguage}=useLanguage();(window as any).__fixtureSetLanguage=setLanguage;return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav>{location.pathname.includes('add-request')?<AddPaymentRequestDialog open onOpenChange={()=>{}}/>:location.pathname.includes('payables')?<PayablesManagement/>:location.pathname.includes('debt')?<NppDebtManagement/>:<FinanceControl mode={location.pathname.includes('classification')?'classification':'ceo'}/>}<Toaster/><Sonner/></>}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}})}><LanguageProvider><StaffUiProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></StaffUiProvider></LanguageProvider></QueryClientProvider>);
