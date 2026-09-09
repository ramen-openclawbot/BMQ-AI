import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';
import { StaffUiProvider } from '@/contexts/StaffUiContext';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import Inventory from '@/pages/Inventory';
import LowStock from '@/pages/LowStock';
import KitchenInventory from '@/pages/KitchenInventory';
import TanTaoWarehouse from '@/pages/TanTaoWarehouse';
import WarehouseDispatch from '@/pages/WarehouseDispatch';
import StockReport from '@/pages/StockReport';
import '@/index.css';
const pages={Inventory,LowStock,KitchenInventory,TanTaoWarehouse,WarehouseDispatch,StockReport};
function Fixture(){
 const {setLanguage}=useLanguage();
 window.__setLanguage=setLanguage;
 const Page=pages[location.pathname.slice(1)] || Inventory;
 return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav><Page/><Toaster/><Sonner/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}})}><LanguageProvider><StaffUiProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></StaffUiProvider></LanguageProvider></QueryClientProvider>);
