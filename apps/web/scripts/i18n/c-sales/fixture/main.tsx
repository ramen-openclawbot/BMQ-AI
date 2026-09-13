import React, {useState} from 'react';
import {KnowledgeBaseProfileEditor} from '@/components/mini-crm/KnowledgeBaseProfileEditor';
import {po} from './mock-client';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LanguageProvider,useLanguage} from '@/contexts/LanguageContext';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Toaster} from '@/components/ui/toaster';
import MiniCrm from '@/pages/MiniCrm';
import FacebookMessengerInbox from '@/pages/FacebookMessengerInbox';
import '@/index.css';
import {StaffUiProvider} from '@/contexts/StaffUiContext';
function KnowledgeFixture(){const [contract,setContract]=useState<any>({status:'draft',source:'email_body',test_evidence:[]});const [profile,setProfile]=useState('Profile giữ nguyên');return <KnowledgeBaseProfileEditor poTemplates={[]} customerPos={location.search.includes('empty')?[]:[po]} editingCustomerId="customer-1" editKbProfileName={profile} editKbPoMode="daily_new_po" editKbBusinessDescription="Mô tả giữ nguyên" kbAiSuggestion={null} kbAiStatus="" kbChangeNote="Ghi chú giữ nguyên" templateFileName="" templateAiContext="" kbAiSuggestPending={false} submitPending={false} approvePending={false} pendingCount={0} canApproveLatest={true} activeKnowledgeProfile={{profile_name:'Profile giữ nguyên',po_mode:'daily_new_po'}} knowledgeVersionHistory={[{id:'v1',version_no:1,is_active:true}]} parseContract={contract} currentUserLabel="staff-fixture" onKbProfileNameChange={setProfile} onKbPoModeChange={()=>{}} onKbBusinessDescriptionChange={()=>{}} onKbChangeNoteChange={()=>{}} onTemplateFileChange={()=>{}} onClearTemplate={()=>{}} onAiSuggest={()=>{}} onSubmitApproval={()=>{}} onApproveLatest={()=>{(window as any).__approvedContract=contract}} onParseContractChange={c=>{setContract(c);(window as any).__contract=c}}/>}
function Fixture(){const {setLanguage}=useLanguage();(window as any).__fixtureSetLanguage=setLanguage;return <><nav aria-label="Fixture language"><button onClick={()=>setLanguage('vi')}>VI</button><button onClick={()=>setLanguage('en')}>EN</button></nav>{location.pathname==='/knowledge-fixture'?<KnowledgeFixture/>:location.pathname==='/facebook-messenger'?<FacebookMessengerInbox/>:<MiniCrm/>}<Toaster/></>}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}})}><LanguageProvider><StaffUiProvider><TooltipProvider><BrowserRouter><Fixture/></BrowserRouter></TooltipProvider></StaffUiProvider></LanguageProvider></QueryClientProvider>);
