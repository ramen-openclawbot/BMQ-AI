import { useState, useEffect, useCallback, useRef } from "react";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle,
  DialogDescription,
  DialogFooter 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  Loader2, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  FolderOpen,
  FileImage,
  ArrowRight,
  Search,
  Plus
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import { uploadPaymentRequestImage } from "@/hooks/usePaymentRequests";
import { generatePONumber } from "@/hooks/usePurchaseOrders";
import { generateShortCode } from "@/components/dialogs/AddSupplierDialog";
import { AddPaymentRequestDialog, PRPrefillData } from "@/components/dialogs/AddPaymentRequestDialog";

interface DriveImportProgressDialogProps {
  open: boolean;
  onClose: (success?: boolean) => void;
  importType: 'po' | 'bank_slip';
}

interface FileStatus {
  id: string;
  name: string;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'skipped';
  message?: string;
  resultId?: string;
  base64?: string;
  mimeType?: string;
}

interface DateInfo {
  date: string;
  fileCount: number;
  folderId?: string;
}

interface PendingMatch {
  file: FileStatus;
  originalFile: any;
  folderDate: string;
  slipData: { amount: number; recipient_name: string; transaction_date?: string; transaction_id?: string };
  matchedPR: any;
}

interface UnmatchedSlip {
  file: FileStatus;
  originalFile: any;
  folderDate: string;
  slipData: { 
    amount: number; 
    recipient_name: string; 
    transaction_date?: string; 
    transaction_id?: string;
  };
  suggestedSupplier?: { id: string; name: string; matchScore: number } | null;
}

interface UnmatchedPOFile {
  file: FileStatus;
  originalFile: any;
  folderDate: string;
  poData: any;
  supplierName: string;
  suggestedSupplier?: { id: string; name: string; matchScore: number } | null;
}

interface SupplierOption {
  id: string;
  name: string;
  bank_account_name?: string | null;
}

type ImportPhase = 
  | 'idle' 
  | 'checking_config' 
  | 'auto_scanning'
  | 'checking_today'
  | 'no_new_files_prompt'
  | 'loading_dates'
  | 'select_dates'
  | 'select_po_files'
  | 'scanning_folder' 
  | 'processing_files' 
  | 'confirm_supplier_name'
  | 'confirm_po_supplier'
  | 'ask_pr_mode'  // NEW: Ask user how to create PR after PO creation
  | 'create_pr_from_unc'
  | 'complete';

// Type for pending PO waiting for PR creation decision
interface PendingPOForPR {
  poId: string;
  poNumber: string;
  supplierId: string | null;
  supplierName: string;
  poData: any;
  imagePath: string | null;
  originalFileId: string;
}

// Auto-confirm threshold for supplier matching
const AUTO_CONFIRM_THRESHOLD = 0.85;

// Parallel processing limit
const PARALLEL_LIMIT = 3;

// Timeout for import initialization to prevent Safari deadlock
const IMPORT_INIT_TIMEOUT = 25000;

// Format "250125" -> "25/01/2025"
const formatFolderDate = (dateStr: string): string => {
  if (dateStr.length !== 6) return dateStr;
  const day = dateStr.substring(0, 2);
  const month = dateStr.substring(2, 4);
  const year = dateStr.substring(4, 6);
  return `${day}/${month}/20${year}`;
};

// Helper function to find best matching supplier by fuzzy name match
const findBestMatchingSupplier = (
  recipientName: string, 
  suppliers: SupplierOption[]
): { id: string; name: string; matchScore: number } | null => {
  const recipientLower = recipientName?.toLowerCase()?.trim() || '';
  if (!recipientLower) return null;
  
  let bestMatch: { id: string; name: string; matchScore: number } | null = null;
  
  for (const supplier of suppliers) {
    const supplierName = supplier.name?.toLowerCase()?.trim() || '';
    const bankName = supplier.bank_account_name?.toLowerCase()?.trim() || '';
    
    // Check if bank_account_name matches exactly (already learned alias)
    if (bankName && recipientLower === bankName) {
      return { id: supplier.id, name: supplier.name, matchScore: 1.0 };
    }
    
    // Check word overlap between recipient and supplier name
    const recipientWords = recipientLower.split(/\s+/).filter(w => w.length > 2);
    const supplierWords = supplierName.split(/\s+/).filter(w => w.length > 2);
    
    if (recipientWords.length === 0) continue;
    
    const matchingWords = recipientWords.filter(rw => 
      supplierWords.some(sw => sw.includes(rw) || rw.includes(sw))
    );
    
    if (matchingWords.length > 0) {
      const score = matchingWords.length / recipientWords.length;
      if (!bestMatch || score > bestMatch.matchScore) {
        bestMatch = {
          id: supplier.id,
          name: supplier.name,
          matchScore: score,
        };
      }
    }
  }
  
  return bestMatch;
};

// Upload PO image to storage and return path only (not signed URL)
async function uploadPOImage(base64: string, mimeType: string, fileName: string): Promise<string | null> {
  try {
    const imageBlob = await fetch(`data:${mimeType};base64,${base64}`).then(r => r.blob());
    const imageFile = new File([imageBlob], fileName, { type: mimeType });
    
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(7);
    const ext = mimeType.split('/')[1] || 'jpg';
    const path = `${timestamp}-${randomStr}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('purchase-orders')
      .upload(path, imageFile);

    if (uploadError) throw uploadError;
    
    return path; // Return path only, not signed URL
  } catch (err) {
    console.error('Failed to upload PO image:', err);
    return null;
  }
}

export function DriveImportProgressDialog({ 
  open, 
  onClose, 
  importType 
}: DriveImportProgressDialogProps) {
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [currentDate, setCurrentDate] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ created: 0, matched: 0, failed: 0, skipped: 0 });
  
  // Multi-date selection state (for bank_slip)
  const [unpaidCount, setUnpaidCount] = useState<number>(0);
  const [availableDates, setAvailableDates] = useState<DateInfo[]>([]);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<'all' | 'select'>('all');
  const [folderUrl, setFolderUrl] = useState<string>('');
  const [authToken, setAuthToken] = useState<string>('');
  
  // Pending supplier confirmation state
  const [pendingMatches, setPendingMatches] = useState<PendingMatch[]>([]);
  const [currentPendingIndex, setCurrentPendingIndex] = useState(0);
  const [isConfirming, setIsConfirming] = useState(false);

  // Unmatched UNC state (new)
  const [unmatchedSlips, setUnmatchedSlips] = useState<UnmatchedSlip[]>([]);
  const [currentUnmatchedIndex, setCurrentUnmatchedIndex] = useState(0);
  const [allSuppliers, setAllSuppliers] = useState<SupplierOption[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [updateBankName, setUpdateBankName] = useState(true);
  const [actionMode, setActionMode] = useState<'create_pr' | 'skip'>('create_pr');
  
  // Progress tracking
  const [totalFilesToProcess, setTotalFilesToProcess] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);

  // PO file selection state (new)
  const [selectedPOFiles, setSelectedPOFiles] = useState<string[]>([]);
  const [poSelectionMode, setPOSelectionMode] = useState<'all' | 'select'>('all');

  // Unmatched PO supplier state
  const [unmatchedPOFiles, setUnmatchedPOFiles] = useState<UnmatchedPOFile[]>([]);
  const [currentUnmatchedPOIndex, setCurrentUnmatchedPOIndex] = useState(0);
  const [poSupplierAction, setPOSupplierAction] = useState<'select' | 'create'>('select');
  const [selectedPOSupplierId, setSelectedPOSupplierId] = useState<string | null>(null);
  const [savePOBankName, setSavePOBankName] = useState(true);
  const [vatIncludedChoice, setVatIncludedChoice] = useState<boolean | null>(null);

  // NEW: Inline supplier creation form state
  const [newSupplierName, setNewSupplierName] = useState('');
  const [newSupplierPhone, setNewSupplierPhone] = useState('');
  const [newSupplierPaymentMethod, setNewSupplierPaymentMethod] = useState<'bank_transfer' | 'cash'>('bank_transfer');

  // NEW: State for ask_pr_mode phase - USE QUEUE for multiple files
  const [pendingPOQueue, setPendingPOQueue] = useState<PendingPOForPR[]>([]);
  const pendingPOForPR = pendingPOQueue[0] || null; // Derived state - current item to process
  const [prCreationMode, setPRCreationMode] = useState<'auto' | 'manual'>('auto');
  const [showManualPRDialog, setShowManualPRDialog] = useState(false);
  const [manualPRDialogData, setManualPRDialogData] = useState<any>(null);

  // Ref to track when we should transition to ask_pr_mode after queue update
  const shouldTransitionToAskPR = useRef(false);

  const getTodayFolderName = () => {
    return format(new Date(), 'ddMMyy');
  };

  const togglePOFile = (fileId: string, checked: boolean | 'indeterminate') => {
    if (checked === true) {
      setSelectedPOFiles(prev => [...prev, fileId]);
    } else {
      setSelectedPOFiles(prev => prev.filter(id => id !== fileId));
    }
  };

  const resetState = useCallback(() => {
    setPhase('idle');
    setFiles([]);
    setError(null);
    setStats({ created: 0, matched: 0, failed: 0, skipped: 0 });
    setUnpaidCount(0);
    setAvailableDates([]);
    setSelectedDates([]);
    setSelectionMode('all');
    setFolderUrl('');
    setAuthToken('');
    setCurrentDate('');
    setPendingMatches([]);
    setCurrentPendingIndex(0);
    setIsConfirming(false);
    // Reset unmatched state
    setUnmatchedSlips([]);
    setCurrentUnmatchedIndex(0);
    // DON'T reset allSuppliers - keep cached for subsequent uses to prevent timeout on reload
    // setAllSuppliers([]);
    setSelectedSupplierId(null);
    setUpdateBankName(true);
    setActionMode('create_pr');
    // Reset progress
    setTotalFilesToProcess(0);
    setProcessedCount(0);
    // Reset PO selection state
    setSelectedPOFiles([]);
    setPOSelectionMode('all');
    // Reset unmatched PO state
    setUnmatchedPOFiles([]);
    setCurrentUnmatchedPOIndex(0);
    setPOSupplierAction('select');
    setSelectedPOSupplierId(null);
    setSavePOBankName(true);
    setVatIncludedChoice(null);
    // Reset inline supplier creation form
    setNewSupplierName('');
    setNewSupplierPhone('');
    setNewSupplierPaymentMethod('bank_transfer');
    // Reset ask_pr_mode state - clear the queue
    setPendingPOQueue([]);
    setPRCreationMode('auto');
    setShowManualPRDialog(false);
    setManualPRDialogData(null);
    shouldTransitionToAskPR.current = false;
  }, []);

  // useEffect to handle phase transition after pendingPOQueue is updated
  // This ensures the phase change happens AFTER the queue state is committed
  useEffect(() => {
    console.log('[useEffect pendingPOQueue] Triggered, queue length:', pendingPOQueue.length, 
                'shouldTransition:', shouldTransitionToAskPR.current);
    
    if (shouldTransitionToAskPR.current && pendingPOQueue.length > 0) {
      console.log('[useEffect pendingPOQueue] Transitioning to ask_pr_mode');
      shouldTransitionToAskPR.current = false;
      setPRCreationMode('auto');
      setPhase('ask_pr_mode');
    }
  }, [pendingPOQueue]);

  // Load all suppliers for dropdown
  const loadSuppliers = async () => {
    try {
      const { data } = await supabase
        .from('suppliers')
        .select('id, name, bank_account_name')
        .order('name');
      setAllSuppliers(data || []);
    } catch (err) {
      console.error('Failed to load suppliers:', err);
      setAllSuppliers([]);
    }
  };

  const startImport = useCallback(async () => {
    setPhase('checking_config');
    setError(null);
    setFiles([]);
    setStats({ created: 0, matched: 0, failed: 0, skipped: 0 });

    const folderDate = getTodayFolderName();
    setCurrentDate(folderDate);

    // Watchdog timer to prevent infinite loading (Safari deadlock protection)
    const timeoutId = setTimeout(() => {
      console.warn('[DriveImport] Import initialization timed out after', IMPORT_INIT_TIMEOUT, 'ms');
      setError('Đã quá thời gian chờ. Vui lòng đóng và thử lại.');
      setPhase('complete');
    }, IMPORT_INIT_TIMEOUT);

    try {
      // Load suppliers for later use (only if not already cached)
      if (allSuppliers.length === 0) {
        await loadSuppliers();
      }

      // Get folder URL from app_settings
      const settingKey = importType === 'po' 
        ? 'google_drive_po_folder' 
        : 'google_drive_receipts_folder';

      const { data: settingData, error: settingError } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', settingKey)
        .maybeSingle();

      if (settingError || !settingData?.value) {
        clearTimeout(timeoutId);
        setError(
          importType === 'po'
            ? 'Chưa cấu hình folder PO. Vui lòng cấu hình trong Cài đặt → Google Drive Integration'
            : 'Chưa cấu hình folder Bank Receipts. Vui lòng cấu hình trong Cài đặt → Google Drive Integration'
        );
        setPhase('complete');
        return;
      }

      const url = settingData.value;
      setFolderUrl(url);

      // Get auth token
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      if (!token) {
        clearTimeout(timeoutId);
        setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        setPhase('complete');
        return;
      }

      setAuthToken(token);
      clearTimeout(timeoutId); // Clear watchdog once we have token

      // For PO: Scan only today's folder first (similar to bank_slip flow)
      if (importType === 'po') {
        await startPOImportFlow(url, token);
        return;
      }

      // For bank_slip: Auto-scan all folders immediately (new simplified flow)
      if (importType === 'bank_slip') {
        await loadAllDatesAutomatically(url, token);
        return;
      }

    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error('Import error:', err);
      setError(err.message || 'Đã xảy ra lỗi');
      setPhase('complete');
    }
  }, [importType, allSuppliers.length]);

  // NEW: PO Import Flow - Scan only today's folder first (like bank_slip flow)
  const startPOImportFlow = async (url: string, token: string) => {
    setPhase('checking_today');
    const todayFolder = getTodayFolderName();
    setCurrentDate(todayFolder);
    
    try {
      // 1. Scan today's folder
      const scanResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            folderUrl: url,
            subfolderDate: todayFolder,
          }),
        }
      );

      if (!scanResponse.ok) {
        // Folder for today might not exist - show prompt to check other dates
        setPhase('no_new_files_prompt');
        return;
      }

      const scanData = await scanResponse.json();
      const allFiles = scanData.files || [];

      if (allFiles.length === 0) {
        // No files in today's folder - offer to check other dates
        setPhase('no_new_files_prompt');
        return;
      }

      // 2. Check which files are already processed via drive_file_index
      const fileIds = allFiles.map((f: any) => f.id);
      const { data: processedFiles } = await supabase
        .from('drive_file_index')
        .select('file_id')
        .eq('folder_type', 'po')
        .eq('processed', true)
        .in('file_id', fileIds);

      const processedSet = new Set(processedFiles?.map(f => f.file_id) || []);
      const newFiles = allFiles.filter((f: any) => !processedSet.has(f.id));

      if (newFiles.length === 0) {
        setPhase('no_new_files_prompt');
        return;
      }

      // 3. Show selection UI - store files for processing
      setAvailableDates([{
        date: todayFolder,
        fileCount: newFiles.length,
      }]);
      
      // Store original files for later processing
      setFiles(newFiles.map((f: any) => ({
        id: f.id,
        name: f.name,
        status: 'pending' as const,
        base64: f.base64,
        mimeType: f.mimeType,
      })));
      
      setPhase('select_po_files');

    } catch (err: any) {
      console.error('Error in PO import flow:', err);
      setError(err.message || 'Đã xảy ra lỗi');
      setPhase('complete');
    }
  };

  // Load all dates for PO (fallback when today has no files)
  const loadAllDatesPO = async () => {
    setPhase('loading_dates');
    
    try {
      // 1. List all date folders from Drive
      const listResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            folderUrl,
            mode: 'list_all_dates',
          }),
        }
      );

      if (!listResponse.ok) {
        setError('Không thể quét folder Google Drive');
        setPhase('complete');
        return;
      }

      const listData = await listResponse.json();
      const dates: DateInfo[] = listData.dates || [];

      if (dates.length === 0) {
        setError('Không tìm thấy folder ngày nào trong thư mục PO');
        setPhase('complete');
        return;
      }

      // 2. Scan folders in parallel (limited to 3 concurrent)
      const allFolderData: { date: string; files: any[] }[] = [];
      
      for (let i = 0; i < dates.length; i += PARALLEL_LIMIT) {
        const batch = dates.slice(i, i + PARALLEL_LIMIT);
        const results = await Promise.all(
          batch.map(async (dateInfo) => {
            try {
              const scanResponse = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`,
                  },
                  body: JSON.stringify({
                    folderUrl,
                    subfolderDate: dateInfo.date,
                  }),
                }
              );

              if (scanResponse.ok) {
                const scanData = await scanResponse.json();
                return { date: dateInfo.date, files: scanData.files || [] };
              }
              return { date: dateInfo.date, files: [] };
            } catch {
              return { date: dateInfo.date, files: [] };
            }
          })
        );
        allFolderData.push(...results);
      }

      // 3. Batch check ALL file IDs via drive_file_index
      const allFileIds = allFolderData.flatMap(d => d.files.map((f: any) => f.id));
      
      let processedSet = new Set<string>();
      if (allFileIds.length > 0) {
        const { data: processedFiles } = await supabase
          .from('drive_file_index')
          .select('file_id')
          .eq('folder_type', 'po')
          .eq('processed', true)
          .in('file_id', allFileIds);

        processedSet = new Set(processedFiles?.map(f => f.file_id) || []);
      }

      // 4. Calculate new file counts for each date
      const datesWithNewFiles = allFolderData
        .map(d => ({
          date: d.date,
          fileCount: d.files.filter((f: any) => !processedSet.has(f.id)).length,
        }))
        .filter(d => d.fileCount > 0);

      if (datesWithNewFiles.length === 0) {
        setError('Không có PO mới để import');
        setPhase('complete');
        return;
      }

      setAvailableDates(datesWithNewFiles);
      setPhase('select_dates');

    } catch (err: any) {
      console.error('Error loading dates for PO:', err);
      setError(err.message || 'Đã xảy ra lỗi');
      setPhase('complete');
    }
  };

  // Start processing selected PO files
  const startProcessingSelectedPO = async () => {
    const filesToProcess = poSelectionMode === 'all'
      ? files.filter(f => f.status === 'pending')
      : files.filter(f => selectedPOFiles.includes(f.id));

    if (filesToProcess.length === 0) {
      toast.error('Vui lòng chọn ít nhất 1 file');
      return;
    }

    // Clear any previous unmatched PO files
    setUnmatchedPOFiles([]);
    setTotalFilesToProcess(filesToProcess.length);
    setProcessedCount(0);
    setPhase('processing_files');

    // Process files in parallel batches
    for (let i = 0; i < filesToProcess.length; i += PARALLEL_LIMIT) {
      const batch = filesToProcess.slice(i, i + PARALLEL_LIMIT);
      
      await Promise.all(
        batch.map(async (file) => {
          setFiles(prev => prev.map(f => 
            f.id === file.id ? { ...f, status: 'processing' } : f
          ));
          
          try {
            await processPOFileAuto(
              { id: file.id, name: file.name, base64: file.base64, mimeType: file.mimeType },
              currentDate,
              authToken
            );
            setProcessedCount(prev => prev + 1);
          } catch (err: any) {
            console.error(`Error processing file ${file.name}:`, err);
            setFiles(prev => prev.map(f => 
              f.id === file.id ? { ...f, status: 'failed', message: err.message } : f
            ));
            setStats(prev => ({ ...prev, failed: prev.failed + 1 }));
            setProcessedCount(prev => prev + 1);
          }
        })
      );
    }

    // After ALL files processed, check pendingPOQueue first, then unmatched files
    // Use functional update to get current queue state
    setPendingPOQueue(currentQueue => {
      if (currentQueue.length > 0) {
        // Has PO(s) waiting for PR decision - go to ask_pr_mode
        setPRCreationMode('auto');
        setPhase('ask_pr_mode');
        return currentQueue;
      }
      
      // No pending PO, check for unmatched files needing supplier confirmation
      setUnmatchedPOFiles(currentUnmatched => {
        if (currentUnmatched.length > 0) {
          setCurrentUnmatchedPOIndex(0);
          setPOSupplierAction('select');
          setSelectedPOSupplierId(null);
          setPhase('confirm_po_supplier');
        } else {
          setPhase('complete');
        }
        return currentUnmatched;
      });
      
      return currentQueue;
    });
  };

  // Start processing PO files from selected dates (for select_dates phase)
  const startProcessingSelectedDatesPO = async () => {
    setPhase('scanning_folder');
    setFiles([]);
    setStats({ created: 0, matched: 0, failed: 0, skipped: 0 });
    setUnmatchedPOFiles([]);
    setCurrentUnmatchedPOIndex(0);

    const datesToProcess = selectionMode === 'all' 
      ? availableDates.map(d => d.date)
      : selectedDates;

    const allFilesToProcess: FileStatus[] = [];
    const allFolderDates: string[] = [];

    try {
      // Collect all files from selected date folders
      for (const date of datesToProcess) {
        setCurrentDate(date);
        
        // Scan folder for this date
        const scanResponse = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              folderUrl,
              subfolderDate: date,
            }),
          }
        );

        if (!scanResponse.ok) {
          console.error(`Failed to scan folder for date ${date}`);
          continue;
        }

        const scanData = await scanResponse.json();
        const scannedFiles = scanData.files || [];

        if (scannedFiles.length === 0) continue;

        // Check which files are already processed via drive_file_index
        const fileIds = scannedFiles.map((f: any) => f.id);
        const { data: processedFiles } = await supabase
          .from('drive_file_index')
          .select('file_id')
          .eq('folder_type', 'po')
          .eq('processed', true)
          .in('file_id', fileIds);

        const processedIds = new Set(processedFiles?.map(f => f.file_id) || []);

        // Initialize file statuses
        const fileStatuses: FileStatus[] = scannedFiles.map((file: any) => ({
          id: file.id,
          name: file.name,
          status: processedIds.has(file.id) ? 'skipped' : 'pending',
          message: processedIds.has(file.id) ? 'Đã import trước đó' : undefined,
          base64: file.base64,
          mimeType: file.mimeType,
        }));

        const newFiles = fileStatuses.filter(f => f.status === 'pending');
        for (const file of newFiles) {
          allFilesToProcess.push(file);
          allFolderDates.push(date);
        }

        setFiles(prev => [...prev, ...fileStatuses]);
        setStats(prev => ({ ...prev, skipped: prev.skipped + processedIds.size }));
      }

      if (allFilesToProcess.length === 0) {
        toast.info('Không có file mới để xử lý');
        setPhase('complete');
        return;
      }

      // Set total count for progress tracking
      setTotalFilesToProcess(allFilesToProcess.length);
      setProcessedCount(0);
      setPhase('processing_files');

      // Process all files in parallel batches
      for (let i = 0; i < allFilesToProcess.length; i += PARALLEL_LIMIT) {
        const batch = allFilesToProcess.slice(i, i + PARALLEL_LIMIT);
        
        await Promise.all(
          batch.map(async (file, batchIndex) => {
            const idx = i + batchIndex;
            const folderDate = allFolderDates[idx];

            setFiles(prev => prev.map(f => 
              f.id === file.id ? { ...f, status: 'processing' } : f
            ));

            try {
              await processPOFileAuto(
                { id: file.id, name: file.name, base64: file.base64, mimeType: file.mimeType },
                folderDate,
                authToken
              );
              setProcessedCount(prev => prev + 1);
            } catch (err: any) {
              console.error(`Error processing file ${file.name}:`, err);
              setFiles(prev => prev.map(f => 
                f.id === file.id ? { ...f, status: 'failed', message: err.message } : f
              ));
              setStats(prev => ({ ...prev, failed: prev.failed + 1 }));
              setProcessedCount(prev => prev + 1);
            }
          })
        );
      }

      // After ALL files processed, check pendingPOQueue first, then unmatched files
      // Use functional update to get current queue state
      setPendingPOQueue(currentQueue => {
        if (currentQueue.length > 0) {
          // Has PO(s) waiting for PR decision - go to ask_pr_mode
          setPRCreationMode('auto');
          setPhase('ask_pr_mode');
          return currentQueue;
        }
        
        // No pending PO, check for unmatched files needing supplier confirmation
        setUnmatchedPOFiles(currentUnmatched => {
          if (currentUnmatched.length > 0) {
            setCurrentUnmatchedPOIndex(0);
            setPOSupplierAction('select');
            setSelectedPOSupplierId(null);
            setPhase('confirm_po_supplier');
          } else {
            setPhase('complete');
          }
          return currentUnmatched;
        });
        
        return currentQueue;
      });

    } catch (err: any) {
      console.error('Error processing selected dates for PO:', err);
      setError(err.message || 'Đã xảy ra lỗi khi xử lý');
      setPhase('complete');
    }
  };

  // Handler for confirming/creating supplier for unmatched PO
  const handleConfirmPOSupplier = async () => {
    if (unmatchedPOFiles.length === 0) return;
    
    const current = unmatchedPOFiles[currentUnmatchedPOIndex];
    setIsConfirming(true);

    try {
      // CRITICAL FIX: Check if PO was already created (race condition prevention)
      // Look for PO with same image filename in notes
      const { data: existingPO } = await supabase
        .from('purchase_orders')
        .select('id, supplier_id')
        .ilike('notes', `%${current.originalFile.name}%`)
        .maybeSingle();

      let supplierId: string;
      let supplierName: string;

      if (poSupplierAction === 'create') {
        // Use form data - fallback to scanned name if form is empty
        const supplierNameToUse = newSupplierName.trim() || current.supplierName;
        
        // Validate: don't create supplier with "(Không xác định)" name
        if (!supplierNameToUse || supplierNameToUse === '(Không xác định)') {
          toast.error('Vui lòng nhập tên NCC hợp lệ');
          setIsConfirming(false);
          return;
        }
        
        const shortCode = generateShortCode(supplierNameToUse);
        const { data: newSupplier, error } = await supabase
          .from('suppliers')
          .insert({
            name: supplierNameToUse,
            short_code: shortCode,
            phone: newSupplierPhone.trim() || null,
            default_payment_method: newSupplierPaymentMethod,
            vat_included_in_price: vatIncludedChoice,
          })
          .select()
          .single();

        if (error) throw error;
        supplierId = newSupplier.id;
        supplierName = newSupplier.name;
        
        // Add to allSuppliers for future matches
        setAllSuppliers(prev => [...prev, { id: supplierId, name: supplierName }]);
      } else {
        // Use selected supplier
        if (!selectedPOSupplierId) {
          toast.error('Vui lòng chọn nhà cung cấp');
          setIsConfirming(false);
          return;
        }
        supplierId = selectedPOSupplierId;
        const selectedSupplier = allSuppliers.find(s => s.id === supplierId);
        supplierName = selectedSupplier?.name || 'NCC';

        // Optionally save bank account name and VAT config
        if (savePOBankName && current.supplierName && current.supplierName !== '(Không xác định)') {
          const updateData: any = { bank_account_name: current.supplierName };
          if (vatIncludedChoice !== null) {
            updateData.vat_included_in_price = vatIncludedChoice;
          }
          await supabase
            .from('suppliers')
            .update(updateData)
            .eq('id', supplierId);
        } else if (vatIncludedChoice !== null) {
          // Just update VAT config
          await supabase
            .from('suppliers')
            .update({ vat_included_in_price: vatIncludedChoice })
            .eq('id', supplierId);
        }
      }

      // If PO already exists (from race condition), update its supplier_id and check for PR
      if (existingPO) {
        console.log('[handleConfirmPOSupplier] existingPO found:', existingPO.id);
        await supabase
          .from('purchase_orders')
          .update({ supplier_id: supplierId })
          .eq('id', existingPO.id);
        
        // Also update linked PR if any
        await supabase
          .from('payment_requests')
          .update({ supplier_id: supplierId })
          .eq('purchase_order_id', existingPO.id);

        // Check if this PO has a linked Payment Request
        const { data: linkedPR } = await supabase
          .from('payment_requests')
          .select('id')
          .eq('purchase_order_id', existingPO.id)
          .maybeSingle();

        // Mark file as success
        setFiles(prev => prev.map(f => 
          f.id === current.file.id ? { 
            ...f, 
            status: 'success', 
            message: linkedPR ? `Đã cập nhật NCC cho PO` : `Đã cập nhật NCC, cần tạo PR`
          } : f
        ));

        // If PO exists but no PR, add to queue to ask about PR creation
        if (!linkedPR) {
          console.log('[handleConfirmPOSupplier] No linked PR found, adding to queue for PR creation');
          
          // Fetch full PO data to add to queue
          const { data: fullPO } = await supabase
            .from('purchase_orders')
            .select('*, purchase_order_items(*)')
            .eq('id', existingPO.id)
            .single();
          
          if (fullPO) {
            const pendingPO: PendingPOForPR = {
              poId: fullPO.id,
              poNumber: fullPO.po_number,
              supplierId: supplierId,
              supplierName: supplierName,
              poData: {
                supplier_name: supplierName,
                total_amount: fullPO.total_amount || 0,
                vat_amount: fullPO.vat_amount || 0,
                items: fullPO.purchase_order_items?.map((item: any) => ({
                  product_name: item.product_name,
                  quantity: item.quantity,
                  unit: item.unit,
                  unit_price: item.unit_price,
                  line_total: item.line_total,
                })) || [],
              },
              imagePath: fullPO.image_url,
              originalFileId: current.file.id,
            };
            
            // Add to queue and trigger transition
            setPendingPOQueue(prev => {
              console.log('[handleConfirmPOSupplier] Adding existingPO to queue, current length:', prev.length);
              shouldTransitionToAskPR.current = true;
              return [...prev, pendingPO];
            });
            
            setIsConfirming(false);
            return; // useEffect will trigger phase change after queue update
          }
        }
        
        setStats(prev => ({ ...prev, created: prev.created + 1 }));
      } else {
        // Create new PO with the confirmed supplier (adds to pendingPOQueue)
        console.log('[handleConfirmPOSupplier] Calling createPOWithSupplier...');
        await createPOWithSupplier(
          current.originalFile,
          current.folderDate,
          current.poData,
          supplierId,
          supplierName
        );
        
        // shouldTransitionToAskPR.current is now set inside createPOWithSupplier
        // The useEffect watching pendingPOQueue will handle the actual phase change
        console.log('[handleConfirmPOSupplier] After createPOWithSupplier, setting isConfirming=false');
        setIsConfirming(false);
        return; // useEffect will trigger phase change after queue update
      }

      // Only reach here if PO already existed - move to next unmatched file or complete
      if (currentUnmatchedPOIndex < unmatchedPOFiles.length - 1) {
        setCurrentUnmatchedPOIndex(prev => prev + 1);
        setPOSupplierAction('select');
        setSelectedPOSupplierId(null);
        setSavePOBankName(true);
        setVatIncludedChoice(null);
        // Reset inline form and prefill from next unmatched file
        const nextFile = unmatchedPOFiles[currentUnmatchedPOIndex + 1];
        const nextName = nextFile?.supplierName || '';
        setNewSupplierName(nextName !== '(Không xác định)' ? nextName : '');
        setNewSupplierPhone('');
        setNewSupplierPaymentMethod('bank_transfer');
      } else {
        // Check if there are pending POs from queue
        setPendingPOQueue(currentQueue => {
          if (currentQueue.length > 0) {
            setPRCreationMode('auto');
            setPhase('ask_pr_mode');
          } else {
            setPhase('complete');
          }
          return currentQueue;
        });
      }
    } catch (err: any) {
      console.error('Error confirming PO supplier:', err);
      toast.error('Lỗi: ' + err.message);
    } finally {
      setIsConfirming(false);
    }
  };

  // Handler for skipping current unmatched PO file
  const handleSkipPOFile = () => {
    if (unmatchedPOFiles.length === 0) return;
    
    const current = unmatchedPOFiles[currentUnmatchedPOIndex];
    
    // Mark file as skipped
    setFiles(prev => prev.map(f => 
      f.id === current.file.id ? { ...f, status: 'skipped', message: 'Bỏ qua (chưa có NCC)' } : f
    ));
    setStats(prev => ({ ...prev, skipped: prev.skipped + 1 }));
    
    // Move to next unmatched file or check queue or complete
    if (currentUnmatchedPOIndex < unmatchedPOFiles.length - 1) {
      setCurrentUnmatchedPOIndex(prev => prev + 1);
      setPOSupplierAction('select');
      setSelectedPOSupplierId(null);
      setSavePOBankName(true);
    } else {
      // Check if there are pending POs from queue (from matched files)
      setPendingPOQueue(currentQueue => {
        if (currentQueue.length > 0) {
          setPRCreationMode('auto');
          setPhase('ask_pr_mode');
        } else {
          setPhase('complete');
        }
        return currentQueue;
      });
    }
  };


  // NEW: Process single PO file - Creates Purchase Order AND Payment Request
  // Returns true if processed immediately, false if needs user confirmation for supplier
  const processPOFileAuto = async (
    originalFile: any,
    folderDate: string,
    token: string
  ): Promise<boolean> => {
    // 1. Call AI to scan PO
    const scanResponse = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-purchase-order`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          imageBase64: originalFile.base64,
          mimeType: originalFile.mimeType,
        }),
      }
    );

    if (!scanResponse.ok) {
      throw new Error('Không thể đọc thông tin PO');
    }

    const scanData = await scanResponse.json();
    const poData = scanData.data;

    // 2. Find or match supplier with fuzzy matching
    let supplierId: string | null = null;
    let supplierName = 'NCC';
    let supplierVatConfig: { vat_included_in_price: boolean } | null = null;
    
    if (poData.supplier_name) {
      // Try exact/partial match first
      const { data: suppliers } = await supabase
        .from('suppliers')
        .select('id, name, bank_account_name, vat_included_in_price')
        .ilike('name', `%${poData.supplier_name}%`)
        .limit(1);

      if (suppliers && suppliers.length > 0) {
        supplierId = suppliers[0].id;
        supplierName = suppliers[0].name;
        supplierVatConfig = { vat_included_in_price: suppliers[0].vat_included_in_price || false };
        
        // If supplier has VAT config and we detected VAT but shouldn't have, adjust
        if (supplierVatConfig.vat_included_in_price && poData.vat_amount > 0) {
          // Supplier's prices include VAT, so reset extracted VAT to 0
          poData.vat_amount = 0;
        }
      } else {
        // Try fuzzy match using findBestMatchingSupplier
        const bestMatch = findBestMatchingSupplier(poData.supplier_name, allSuppliers);
        
        if (bestMatch && bestMatch.matchScore >= AUTO_CONFIRM_THRESHOLD) {
          // High confidence match - use it
          supplierId = bestMatch.id;
          supplierName = bestMatch.name;
          
          // Fetch VAT config for matched supplier
          const { data: supplierData } = await supabase
            .from('suppliers')
            .select('vat_included_in_price')
            .eq('id', supplierId)
            .single();
          
          if (supplierData?.vat_included_in_price) {
            poData.vat_amount = 0; // Reset VAT as it's included in price
          }
        } else {
          // No match or low confidence - queue for user confirmation
          setUnmatchedPOFiles(prev => [...prev, {
            file: { id: originalFile.id, name: originalFile.name, status: 'pending' },
            originalFile,
            folderDate,
            poData,
            supplierName: poData.supplier_name,
            suggestedSupplier: bestMatch,
          }]);
          
          // Mark file as needing confirmation
          setFiles(prev => prev.map(f => 
            f.id === originalFile.id ? { 
              ...f, 
              status: 'pending', 
              message: 'Cần xác nhận NCC' 
            } : f
          ));
          return false; // Don't create PO yet
        }
      }
    } else {
      // NO supplier_name from AI scan - queue for manual supplier selection
      setUnmatchedPOFiles(prev => [...prev, {
        file: { id: originalFile.id, name: originalFile.name, status: 'pending' },
        originalFile,
        folderDate,
        poData,
        supplierName: '(Không xác định)',
        suggestedSupplier: null,
      }]);
      
      // Mark file as needing supplier selection
      setFiles(prev => prev.map(f => 
        f.id === originalFile.id ? { 
          ...f, 
          status: 'pending', 
          message: 'Không tìm thấy tên NCC - cần chọn thủ công' 
        } : f
      ));
      return false; // Don't create PO yet - need supplier confirmation
    }
    
    // Continue with PO creation only if we have a valid supplier
    await createPOWithSupplier(originalFile, folderDate, poData, supplierId, supplierName);
    return true;
  };

  // Helper function to create PO only (without PR) - returns PO info for later PR creation
  const createPOOnly = async (
    originalFile: any,
    folderDate: string,
    poData: any,
    supplierId: string | null,
    supplierName: string
  ): Promise<PendingPOForPR> => {
    // 1. Upload image to storage (save path only)
    const imagePath = await uploadPOImage(
      originalFile.base64, 
      originalFile.mimeType, 
      originalFile.name
    );

    // 2. Generate PO number
    const poNumber = await generatePONumber();

    // 3. Parse order date from AI data or use today
    let orderDate = new Date().toISOString().split('T')[0];
    if (poData.order_date) {
      const parts = poData.order_date.split('/');
      if (parts.length === 3) {
        const [day, month, year] = parts;
        orderDate = `${year.length === 2 ? '20' + year : year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }

    // 4. Create Purchase Order
    const { data: createdPO, error: poError } = await supabase
      .from('purchase_orders')
      .insert({
        po_number: poNumber,
        order_date: orderDate,
        expected_date: poData.expected_date || null,
        supplier_id: supplierId,
        total_amount: poData.total_amount || 0,
        vat_amount: poData.vat_amount || 0,
        status: 'draft',
        image_url: imagePath,
        notes: `Import từ Google Drive - ${originalFile.name} (${formatFolderDate(folderDate)})`,
      })
      .select()
      .single();

    if (poError) throw poError;

    // 5. Create PO items
    if (poData.items && Array.isArray(poData.items)) {
      for (const item of poData.items) {
        await supabase
          .from('purchase_order_items')
          .insert({
            purchase_order_id: createdPO.id,
            product_name: item.product_name || 'Sản phẩm',
            quantity: item.quantity || 1,
            unit: item.unit || 'kg',
            unit_price: item.unit_price || 0,
            line_total: (item.quantity || 0) * (item.unit_price || 0),
            notes: item.notes,
          });
      }
    }

    // 6. Update drive_file_index to mark as processed
    await supabase
      .from('drive_file_index')
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        purchase_order_id: createdPO.id,
      })
      .eq('file_id', originalFile.id);

    // 7. Update file status to show PO created
    setFiles(prev => prev.map(f => 
      f.id === originalFile.id ? { 
        ...f, 
        status: 'success', 
        message: `Tạo ${poNumber} - Chờ tạo PR`,
        resultId: createdPO.id 
      } : f
    ));

    return {
      poId: createdPO.id,
      poNumber,
      supplierId,
      supplierName,
      poData,
      imagePath,
      originalFileId: originalFile.id,
    };
  };

  // Helper function to create PR from existing PO
  const createPRFromPO = async (pendingPO: PendingPOForPR) => {
    const prNumber = `PR-${pendingPO.poNumber.replace('PO-', '')}`;
    
    const { data: createdPR, error: prError } = await supabase
      .from('payment_requests')
      .insert({
        request_number: prNumber,
        title: `Thanh toán ${pendingPO.poNumber}`,
        description: `Đề nghị thanh toán cho ${pendingPO.supplierName} - Import từ Google Drive`,
        supplier_id: pendingPO.supplierId,
        purchase_order_id: pendingPO.poId,
        total_amount: pendingPO.poData.total_amount || 0,
        vat_amount: pendingPO.poData.vat_amount || 0,
        status: 'pending',
        payment_status: 'unpaid',
        payment_type: 'new_order',
        payment_method: 'bank_transfer',
        notes: `Tạo tự động từ ${pendingPO.poNumber}`,
        image_url: pendingPO.imagePath,
      })
      .select()
      .single();

    if (prError) throw prError;

    // Create PR items from PO items
    if (pendingPO.poData.items && Array.isArray(pendingPO.poData.items)) {
      for (const item of pendingPO.poData.items) {
        await supabase
          .from('payment_request_items')
          .insert({
            payment_request_id: createdPR.id,
            product_name: item.product_name || 'Sản phẩm',
            quantity: item.quantity || 1,
            unit: item.unit || 'kg',
            unit_price: item.unit_price || 0,
            line_total: item.line_total || (item.quantity * item.unit_price) || 0,
            notes: item.notes,
          });
      }
    }

    // Update drive_file_index with PR id
    await supabase
      .from('drive_file_index')
      .update({ payment_request_id: createdPR.id })
      .eq('file_id', pendingPO.originalFileId);

    // Update file status
    setFiles(prev => prev.map(f => 
      f.id === pendingPO.originalFileId ? { 
        ...f, 
        message: `Tạo ${pendingPO.poNumber} + ${prNumber}` 
      } : f
    ));

    return createdPR;
  };

  // Creates PO and adds to pending queue for PR decision
  // NOTE: Sets shouldTransitionToAskPR ref INSIDE setPendingPOQueue callback to ensure sync
  const createPOWithSupplier = async (
    originalFile: any,
    folderDate: string,
    poData: any,
    supplierId: string | null,
    supplierName: string
  ) => {
    console.log('[createPOWithSupplier] Starting for file:', originalFile.name);
    
    const pendingPO = await createPOOnly(originalFile, folderDate, poData, supplierId, supplierName);
    
    console.log('[createPOWithSupplier] PO created:', pendingPO.poNumber);
    
    // Set ref INSIDE the callback to ensure sync with queue update
    setPendingPOQueue(prev => {
      console.log('[createPOWithSupplier] Adding to queue, current length:', prev.length);
      shouldTransitionToAskPR.current = true;
      return [...prev, pendingPO];
    });
    
    setStats(prev => ({ ...prev, created: prev.created + 1 }));
    console.log('[createPOWithSupplier] Complete');
  };

  // Handler for confirming PR creation mode
  const handlePRModeConfirm = async () => {
    if (!pendingPOForPR) return;
    
    setIsConfirming(true);
    
    try {
      if (prCreationMode === 'auto') {
        // Create PR automatically
        await createPRFromPO(pendingPOForPR);
        toast.success(`Đã tạo ${pendingPOForPR.poNumber} + PR thành công!`);
        
        // Move to next file or complete
        moveToNextPOFileOrComplete();
      } else {
        // Open manual PR dialog with prefilled data
        setManualPRDialogData({
          poId: pendingPOForPR.poId,
          poNumber: pendingPOForPR.poNumber,
          supplierId: pendingPOForPR.supplierId,
          supplierName: pendingPOForPR.supplierName,
          items: pendingPOForPR.poData.items || [],
          total: pendingPOForPR.poData.total_amount || 0,
          vat: pendingPOForPR.poData.vat_amount || 0,
          imagePath: pendingPOForPR.imagePath,
        });
        setShowManualPRDialog(true);
        
        toast.success(`Đã tạo ${pendingPOForPR.poNumber}. Vui lòng hoàn tất tạo PR thủ công.`);
        
        // Move to next file or complete (PR will be created in separate dialog)
        moveToNextPOFileOrComplete();
      }
    } catch (err: any) {
      console.error('Error handling PR mode confirm:', err);
      toast.error('Lỗi: ' + err.message);
    } finally {
      setIsConfirming(false);
    }
  };

  // Helper to move to next pending PO in queue, then unmatched files, then remaining pending files, then complete
  const moveToNextPOFileOrComplete = () => {
    // Remove current item from queue and check next
    setPendingPOQueue(prev => {
      const remaining = prev.slice(1); // Remove first item
      
      if (remaining.length > 0) {
        // More items in queue - stay in ask_pr_mode for next PO
        setPRCreationMode('auto');
        setPhase('ask_pr_mode');
      } else {
        // Queue empty - check unmatched files first
        setUnmatchedPOFiles(currentUnmatched => {
          if (currentUnmatched.length > 0) {
            setCurrentUnmatchedPOIndex(0);
            setPOSupplierAction('select');
            setSelectedPOSupplierId(null);
            setSavePOBankName(true);
            setVatIncludedChoice(null);
            setPhase('confirm_po_supplier');
          } else {
            // Check if there are remaining unprocessed files to let user continue
            setFiles(currentFiles => {
              const remainingPendingFiles = currentFiles.filter(
                f => f.status === 'pending'
              );
              
              if (remainingPendingFiles.length > 0) {
                // Reset selection and go back to file selection
                setSelectedPOFiles([]);
                setPOSelectionMode('all');
                toast.info(`Còn ${remainingPendingFiles.length} file chưa xử lý. Bạn có thể tiếp tục chọn file để scan.`);
                setPhase('select_po_files');
              } else {
                setPhase('complete');
              }
              
              return currentFiles;
            });
          }
          return currentUnmatched;
        });
      }
      
      return remaining;
    });
  };

  // Auto-scan all folders for bank_slip (OPTIMIZED: parallel scan + batch import check)
  const loadAllDatesAutomatically = async (url: string, token: string) => {
    setPhase('loading_dates');
    
    try {
      // 1. Count unpaid payment requests
      const { count } = await supabase
        .from('payment_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .eq('payment_status', 'unpaid');
      
      setUnpaidCount(count || 0);

      // 2. List all date folders from Drive
      const listResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            folderUrl: url,
            mode: 'list_all_dates',
          }),
        }
      );

      if (!listResponse.ok) {
        const errorData = await listResponse.json();
        setError(errorData.error || 'Không thể quét folder Google Drive');
        setPhase('complete');
        return;
      }

      const listData = await listResponse.json();
      const dates: DateInfo[] = listData.dates || [];

      if (dates.length === 0) {
        setError('Chưa có UNC để cập nhật');
        setPhase('complete');
        return;
      }

      // 3. OPTIMIZED: Scan folders in PARALLEL (limited to 3 concurrent)
      const allFolderData: { date: string; fileIds: string[]; folderId?: string }[] = [];
      
      for (let i = 0; i < dates.length; i += PARALLEL_LIMIT) {
        const batch = dates.slice(i, i + PARALLEL_LIMIT);
        const results = await Promise.all(
          batch.map(async (dateInfo) => {
            try {
              const scanResponse = await fetch(
                `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    folderUrl: url,
                    subfolderDate: dateInfo.date,
                  }),
                }
              );

              if (scanResponse.ok) {
                const scanData = await scanResponse.json();
                const fileIds = scanData.files?.map((f: any) => f.id) || [];
                return { date: dateInfo.date, fileIds, folderId: dateInfo.folderId };
              }
              return { date: dateInfo.date, fileIds: [], folderId: dateInfo.folderId };
            } catch {
              return { date: dateInfo.date, fileIds: [], folderId: dateInfo.folderId };
            }
          })
        );
        allFolderData.push(...results);
      }

      // 4. OPTIMIZED: Batch check ALL file IDs via drive_file_index
      const allFileIds = allFolderData.flatMap(d => d.fileIds);
      
      let processedSet = new Set<string>();
      if (allFileIds.length > 0) {
        const { data: processedFiles } = await supabase
          .from('drive_file_index')
          .select('file_id')
          .eq('folder_type', 'bank_slip')
          .eq('processed', true)
          .in('file_id', allFileIds);

        processedSet = new Set(processedFiles?.map(f => f.file_id) || []);
      }

      // 5. Calculate new file counts for each date
      const datesWithNewFiles = allFolderData
        .map(d => ({
          date: d.date,
          fileCount: d.fileIds.filter(id => !processedSet.has(id)).length,
          folderId: d.folderId,
        }))
        .filter(d => d.fileCount > 0);

      if (datesWithNewFiles.length === 0) {
        setError('Chưa có UNC để cập nhật');
        setPhase('complete');
        return;
      }

      setAvailableDates(datesWithNewFiles);
      setPhase('select_dates');

    } catch (err: any) {
      console.error('Error loading dates:', err);
      setError(err.message || 'Đã xảy ra lỗi khi tải danh sách ngày');
      setPhase('complete');
    }
  };

  const loadAllDates = async () => {
    setPhase('loading_dates');
    
    try {
      // 1. Count unpaid payment requests
      const { count } = await supabase
        .from('payment_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .eq('payment_status', 'unpaid');
      
      setUnpaidCount(count || 0);

      // 2. List all date folders from Drive
      const listResponse = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            folderUrl,
            mode: 'list_all_dates',
          }),
        }
      );

      if (!listResponse.ok) {
        const errorData = await listResponse.json();
        setError(errorData.error || 'Không thể quét folder Google Drive');
        setPhase('complete');
        return;
      }

      const listData = await listResponse.json();
      const dates: DateInfo[] = listData.dates || [];

      if (dates.length === 0) {
        setError('Không tìm thấy folder ngày nào trong thư mục UNC');
        setPhase('complete');
        return;
      }

      // 3. Filter out dates with all files already imported
      const datesWithNewFiles: DateInfo[] = [];
      
      for (const dateInfo of dates) {
        // Get file IDs for this date folder
        const scanResponse = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              folderUrl,
              subfolderDate: dateInfo.date,
            }),
          }
        );

        if (scanResponse.ok) {
          const scanData = await scanResponse.json();
          const fileIds = scanData.files?.map((f: any) => f.id) || [];
          
          if (fileIds.length > 0) {
            const { data: processedFiles } = await supabase
              .from('drive_file_index')
              .select('file_id')
              .eq('folder_type', 'bank_slip')
              .eq('processed', true)
              .in('file_id', fileIds);

            const processedCount = processedFiles?.length || 0;
            const newFileCount = fileIds.length - processedCount;
            
            if (newFileCount > 0) {
              datesWithNewFiles.push({
                ...dateInfo,
                fileCount: newFileCount,
              });
            }
          }
        }
      }

      if (datesWithNewFiles.length === 0) {
        setError('Tất cả file trong các folder ngày đã được import');
        setPhase('complete');
        return;
      }

      setAvailableDates(datesWithNewFiles);
      setPhase('select_dates');

    } catch (err: any) {
      console.error('Error loading dates:', err);
      setError(err.message || 'Đã xảy ra lỗi khi tải danh sách ngày');
      setPhase('complete');
    }
  };

  // UPDATED: Process files in parallel with auto-confirm for high confidence matches
  const processFilesParallel = async (
    fileStatuses: FileStatus[],
    originalFiles: any[],
    folderDate: string,
    token: string
  ): Promise<{ pendingMatches: PendingMatch[]; unmatchedSlips: UnmatchedSlip[] }> => {
    const filesToProcess = fileStatuses.filter(f => f.status === 'pending');
    const newPendingMatches: PendingMatch[] = [];
    const newUnmatchedSlips: UnmatchedSlip[] = [];

    // Process in parallel batches
    for (let i = 0; i < filesToProcess.length; i += PARALLEL_LIMIT) {
      const batch = filesToProcess.slice(i, i + PARALLEL_LIMIT);
      
      await Promise.all(
        batch.map(async (file) => {
          const originalFile = originalFiles.find((f: any) => f.id === file.id);

          setFiles(prev => prev.map(f => 
            f.id === file.id ? { ...f, status: 'processing' } : f
          ));

          try {
            const result = await processBankSlipFile(file, originalFile, folderDate, token);
            if (result.processed) {
              // Successfully matched and processed
            } else if (result.pendingMatch) {
              // Check for auto-confirm with high confidence
              const suggestedSupplier = findBestMatchingSupplier(
                result.pendingMatch.slipData.recipient_name, 
                allSuppliers
              );
              
              if (suggestedSupplier && suggestedSupplier.matchScore >= AUTO_CONFIRM_THRESHOLD) {
                // AUTO-CONFIRM: High confidence match
                const pr = result.pendingMatch.matchedPR;
                
                // Update bank_account_name
                if (pr.supplier_id) {
                  await supabase
                    .from('suppliers')
                    .update({ bank_account_name: result.pendingMatch.slipData.recipient_name })
                    .eq('id', pr.supplier_id);
                }
                
                // Process the match
                await processMatchedPR(
                  file, 
                  pr, 
                  result.pendingMatch.slipData, 
                  folderDate, 
                  originalFile
                );
                
                toast.success(`Tự động xác nhận NCC "${pr.suppliers?.name}" (${Math.round(suggestedSupplier.matchScore * 100)}% match)`);
              } else {
                // Manual confirmation required
                setFiles(prev => prev.map(f => 
                  f.id === file.id ? { ...f, status: 'pending', message: 'Chờ xác nhận NCC' } : f
                ));
                newPendingMatches.push(result.pendingMatch);
              }
            } else if (result.unmatched) {
              // Mark as unmatched - need to create PR
              setFiles(prev => prev.map(f => 
                f.id === file.id ? { ...f, status: 'pending', message: 'Không tìm thấy PR khớp' } : f
              ));
              newUnmatchedSlips.push(result.unmatched);
            }
            
            setProcessedCount(prev => prev + 1);
          } catch (err: any) {
            console.error(`Error processing file ${file.name}:`, err);
            setFiles(prev => prev.map(f => 
              f.id === file.id ? { ...f, status: 'failed', message: err.message } : f
            ));
            setStats(prev => ({ ...prev, failed: prev.failed + 1 }));
            setProcessedCount(prev => prev + 1);
          }
        })
      );
    }

    return { pendingMatches: newPendingMatches, unmatchedSlips: newUnmatchedSlips };
  };

  const startProcessingSelected = async () => {
    setPhase('scanning_folder');
    setFiles([]);
    setStats({ created: 0, matched: 0, failed: 0, skipped: 0 });
    setPendingMatches([]);
    setCurrentPendingIndex(0);
    setUnmatchedSlips([]);
    setCurrentUnmatchedIndex(0);
    
    const datesToProcess = selectionMode === 'all' 
      ? availableDates.map(d => d.date)
      : selectedDates;

    const allPendingMatches: PendingMatch[] = [];
    const allUnmatchedSlips: UnmatchedSlip[] = [];
    const allFilesToProcess: FileStatus[] = [];
    const allOriginalFiles: any[] = [];
    const allFolderDates: string[] = [];

    try {
      // Collect all files first
      for (const date of datesToProcess) {
        setCurrentDate(date);
        
        // Scan folder for this date
        const scanResponse = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              folderUrl,
              subfolderDate: date,
            }),
          }
        );

        if (!scanResponse.ok) {
          console.error(`Failed to scan folder for date ${date}`);
          continue;
        }

        const scanData = await scanResponse.json();
        const files = scanData.files || [];

        if (files.length === 0) continue;

        // Check which files are already processed via drive_file_index
        const fileIds = files.map((f: any) => f.id);
        const { data: processedFiles } = await supabase
          .from('drive_file_index')
          .select('file_id')
          .eq('folder_type', 'bank_slip')
          .eq('processed', true)
          .in('file_id', fileIds);

        const processedIds = new Set(processedFiles?.map(f => f.file_id) || []);

        // Initialize file statuses
        const fileStatuses: FileStatus[] = files.map((file: any) => ({
          id: file.id,
          name: file.name,
          status: processedIds.has(file.id) ? 'skipped' : 'pending',
          message: processedIds.has(file.id) ? 'Đã import trước đó' : undefined,
          base64: file.base64,
          mimeType: file.mimeType,
        }));

        const newFiles = fileStatuses.filter(f => f.status === 'pending');
        for (const file of newFiles) {
          allFilesToProcess.push(file);
          allOriginalFiles.push(files.find((f: any) => f.id === file.id));
          allFolderDates.push(date);
        }

        setFiles(prev => [...prev, ...fileStatuses]);
        setStats(prev => ({ ...prev, skipped: prev.skipped + processedIds.size }));
      }

      // Set total count for progress tracking
      setTotalFilesToProcess(allFilesToProcess.length);
      setProcessedCount(0);
      setPhase('processing_files');

      // Process all files in parallel
      for (let i = 0; i < allFilesToProcess.length; i += PARALLEL_LIMIT) {
        const batch = allFilesToProcess.slice(i, i + PARALLEL_LIMIT);
        
        await Promise.all(
          batch.map(async (file, batchIndex) => {
            const idx = i + batchIndex;
            const originalFile = allOriginalFiles[idx];
            const folderDate = allFolderDates[idx];

            setFiles(prev => prev.map(f => 
              f.id === file.id ? { ...f, status: 'processing' } : f
            ));

            try {
              const result = await processBankSlipFile(file, originalFile, folderDate, authToken);
              if (result.processed) {
                // Successfully matched and processed
              } else if (result.pendingMatch) {
                // Check for auto-confirm
                const suggestedSupplier = findBestMatchingSupplier(
                  result.pendingMatch.slipData.recipient_name, 
                  allSuppliers
                );
                
                if (suggestedSupplier && suggestedSupplier.matchScore >= AUTO_CONFIRM_THRESHOLD) {
                  // AUTO-CONFIRM
                  const pr = result.pendingMatch.matchedPR;
                  
                  if (pr.supplier_id) {
                    await supabase
                      .from('suppliers')
                      .update({ bank_account_name: result.pendingMatch.slipData.recipient_name })
                      .eq('id', pr.supplier_id);
                  }
                  
                  await processMatchedPR(file, pr, result.pendingMatch.slipData, folderDate, originalFile);
                  toast.success(`Tự động xác nhận "${pr.suppliers?.name}"`);
                } else {
                  setFiles(prev => prev.map(f => 
                    f.id === file.id ? { ...f, status: 'pending', message: 'Chờ xác nhận NCC' } : f
                  ));
                  allPendingMatches.push(result.pendingMatch);
                }
              } else if (result.unmatched) {
                setFiles(prev => prev.map(f => 
                  f.id === file.id ? { ...f, status: 'pending', message: 'Không tìm thấy PR khớp' } : f
                ));
                allUnmatchedSlips.push(result.unmatched);
              }
              
              setProcessedCount(prev => prev + 1);
            } catch (err: any) {
              console.error(`Error processing file ${file.name}:`, err);
              setFiles(prev => prev.map(f => 
                f.id === file.id ? { ...f, status: 'failed', message: err.message } : f
              ));
              setStats(prev => ({ ...prev, failed: prev.failed + 1 }));
              setProcessedCount(prev => prev + 1);
            }
          })
        );
      }

      // Check if there are pending confirmations first
      if (allPendingMatches.length > 0) {
        setPendingMatches(allPendingMatches);
        setCurrentPendingIndex(0);
        // Store unmatched for later
        setUnmatchedSlips(allUnmatchedSlips);
        setPhase('confirm_supplier_name');
      } else if (allUnmatchedSlips.length > 0) {
        // No pending but have unmatched → go to create PR phase
        setUnmatchedSlips(allUnmatchedSlips);
        setCurrentUnmatchedIndex(0);
        setSelectedSupplierId(allUnmatchedSlips[0]?.suggestedSupplier?.id || null);
        setPhase('create_pr_from_unc');
      } else {
        setPhase('complete');
      }

    } catch (err: any) {
      console.error('Error processing selected dates:', err);
      setError(err.message || 'Đã xảy ra lỗi khi xử lý');
      setPhase('complete');
    }
  };

  // Handlers for supplier name confirmation
  const handleConfirmSupplierMatch = async () => {
    if (pendingMatches.length === 0) return;
    
    const current = pendingMatches[currentPendingIndex];
    const pr = current.matchedPR;
    
    setIsConfirming(true);
    
    try {
      // 1. Update supplier with bank_account_name
      if (pr.supplier_id) {
        await supabase
          .from('suppliers')
          .update({ bank_account_name: current.slipData.recipient_name })
          .eq('id', pr.supplier_id);
      }
      
      // 2. Process the match (mark paid, create invoice with UNC image)
      await processMatchedPR(current.file, pr, current.slipData, current.folderDate, current.originalFile);
      
      toast.success(`Đã cập nhật NCC "${pr.suppliers?.name}" với tên thanh toán "${current.slipData.recipient_name}"`);
      
      // 3. Move to next or complete
      moveToNextPending();
    } catch (err: any) {
      console.error('Error confirming supplier match:', err);
      toast.error(err.message || 'Có lỗi xảy ra khi xác nhận');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleSkipSupplierMatch = () => {
    if (pendingMatches.length === 0) return;
    
    const current = pendingMatches[currentPendingIndex];
    
    // Mark file as skipped
    setFiles(prev => prev.map(f => 
      f.id === current.file.id 
        ? { ...f, status: 'skipped', message: 'Bỏ qua - không xác nhận NCC' } 
        : f
    ));
    setStats(prev => ({ ...prev, skipped: prev.skipped + 1 }));
    
    moveToNextPending();
  };

  const moveToNextPending = () => {
    if (currentPendingIndex < pendingMatches.length - 1) {
      setCurrentPendingIndex(prev => prev + 1);
    } else {
      // Done with pending - check for unmatched
      if (unmatchedSlips.length > 0) {
        setCurrentUnmatchedIndex(0);
        setSelectedSupplierId(unmatchedSlips[0]?.suggestedSupplier?.id || null);
        setActionMode('create_pr');
        setPhase('create_pr_from_unc');
      } else {
        setPhase('complete');
      }
    }
  };

  // Handlers for unmatched UNC
  const handleCreatePRFromUNC = async () => {
    if (unmatchedSlips.length === 0 || !selectedSupplierId) return;
    
    const current = unmatchedSlips[currentUnmatchedIndex];
    setIsConfirming(true);
    
    try {
      // 1. Upload UNC image
      let imagePath: string | null = null;
      try {
        const imageBlob = await fetch(`data:${current.originalFile.mimeType};base64,${current.originalFile.base64}`)
          .then(r => r.blob());
        const imageFile = new File([imageBlob], current.file.name, { type: current.originalFile.mimeType });
        imagePath = await uploadPaymentRequestImage(imageFile);
      } catch (uploadErr) {
        console.error('Failed to upload UNC image:', uploadErr);
      }
      
      // 2. Update supplier bank_account_name if requested
      if (updateBankName && selectedSupplierId) {
        await supabase
          .from('suppliers')
          .update({ bank_account_name: current.slipData.recipient_name })
          .eq('id', selectedSupplierId);
      }
      
      // 3. Generate request number
      const { data: lastRequest } = await supabase
        .from('payment_requests')
        .select('request_number')
        .order('created_at', { ascending: false })
        .limit(1);

      let nextNum = 1;
      if (lastRequest && lastRequest.length > 0) {
        const match = lastRequest[0].request_number.match(/PR-(\d+)/);
        if (match) nextNum = parseInt(match[1]) + 1;
      }
      const requestNumber = `PR-${String(nextNum).padStart(6, '0')}`;

      // 4. Create payment request (approved + paid)
      const { data: prData, error: prError } = await supabase
        .from('payment_requests')
        .insert({
          request_number: requestNumber,
          title: `Thanh toán ${current.slipData.recipient_name}`,
          description: `Import từ UNC - ${current.slipData.transaction_id || ''}`,
          supplier_id: selectedSupplierId,
          total_amount: current.slipData.amount,
          vat_amount: 0,
          status: 'approved',
          payment_status: 'paid',
          payment_method: 'bank_transfer',
          payment_type: 'old_order',
          image_url: imagePath,
          approved_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (prError) throw prError;

      // 5. Create invoice with payment_slip_url
      const invoiceNumber = `INV-${format(new Date(), 'yyMMdd')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
      const { data: invoiceData, error: invoiceError } = await supabase
        .from('invoices')
        .insert({
          invoice_number: invoiceNumber,
          invoice_date: current.slipData.transaction_date || new Date().toISOString().split('T')[0],
          supplier_id: selectedSupplierId,
          payment_request_id: prData.id,
          total_amount: current.slipData.amount,
          payment_slip_url: imagePath,
          notes: `Tạo từ UNC - ${current.slipData.transaction_id || ''}`,
        })
        .select()
        .single();

      if (invoiceError) throw invoiceError;

      // 6. Update PR with invoice_id
      await supabase
        .from('payment_requests')
        .update({ invoice_created: true, invoice_id: invoiceData.id })
        .eq('id', prData.id);

      // 7. Update drive_file_index to mark as processed
      await supabase
        .from('drive_file_index')
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          payment_request_id: prData.id,
          invoice_id: invoiceData.id,
        })
        .eq('file_id', current.file.id);

      // Update file status
      setFiles(prev => prev.map(f => 
        f.id === current.file.id 
          ? { ...f, status: 'success', message: `Tạo ${requestNumber}`, resultId: prData.id } 
          : f
      ));

      toast.success(`Đã tạo ${requestNumber} và hoá đơn từ UNC`);
      setStats(prev => ({ ...prev, created: prev.created + 1 }));
      moveToNextUnmatched();
      
    } catch (err: any) {
      console.error('Error creating PR from UNC:', err);
      toast.error(err.message || 'Có lỗi khi tạo đề nghị thanh toán');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleSkipUnmatched = () => {
    if (unmatchedSlips.length === 0) return;
    
    const current = unmatchedSlips[currentUnmatchedIndex];
    
    // Mark file as skipped
    setFiles(prev => prev.map(f => 
      f.id === current.file.id 
        ? { ...f, status: 'skipped', message: 'Bỏ qua - không tạo PR' } 
        : f
    ));
    setStats(prev => ({ ...prev, skipped: prev.skipped + 1 }));
    
    moveToNextUnmatched();
  };

  const moveToNextUnmatched = () => {
    if (currentUnmatchedIndex < unmatchedSlips.length - 1) {
      const nextIndex = currentUnmatchedIndex + 1;
      setCurrentUnmatchedIndex(nextIndex);
      setSelectedSupplierId(unmatchedSlips[nextIndex]?.suggestedSupplier?.id || null);
      setUpdateBankName(true);
      setActionMode('create_pr');
    } else {
      setPhase('complete');
    }
  };

  const toggleDate = (date: string, checked: boolean | 'indeterminate') => {
    if (checked === true) {
      setSelectedDates(prev => [...prev, date]);
    } else {
      setSelectedDates(prev => prev.filter(d => d !== date));
    }
  };

  // Process a matched PR (mark paid, create invoice with UNC image, log)
  const processMatchedPR = async (
    file: FileStatus,
    matchedPR: any,
    slipData: { amount: number; recipient_name: string; transaction_date?: string; transaction_id?: string },
    folderDate: string,
    originalFile?: any
  ) => {
    // Upload UNC image if available
    let paymentSlipPath: string | null = null;
    if (originalFile?.base64 && originalFile?.mimeType) {
      try {
        const imageBlob = await fetch(`data:${originalFile.mimeType};base64,${originalFile.base64}`)
          .then(r => r.blob());
        const imageFile = new File([imageBlob], file.name, { type: originalFile.mimeType });
        paymentSlipPath = await uploadPaymentRequestImage(imageFile);
      } catch (uploadErr) {
        console.error('Failed to upload UNC image:', uploadErr);
      }
    }

    // Mark as paid
    await supabase
      .from('payment_requests')
      .update({ 
        payment_status: 'paid',
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchedPR.id);

    // Create invoice if not exists
    let invoiceId: string | null = null;
    if (!matchedPR.invoice_created) {
      const invoiceNumber = `INV-${format(new Date(), 'yyMMdd')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      const { data: invoiceData } = await supabase
        .from('invoices')
        .insert({
          invoice_number: invoiceNumber,
          invoice_date: slipData.transaction_date || new Date().toISOString().split('T')[0],
          supplier_id: matchedPR.supplier_id,
          payment_request_id: matchedPR.id,
          total_amount: matchedPR.total_amount,
          vat_amount: matchedPR.vat_amount || 0,
          subtotal: (matchedPR.total_amount || 0) - (matchedPR.vat_amount || 0),
          notes: `Tạo tự động từ UNC - ${slipData.transaction_id || ''}`,
          payment_slip_url: paymentSlipPath,
        })
        .select()
        .single();

      if (invoiceData) {
        invoiceId = invoiceData.id;
        
        await supabase
          .from('payment_requests')
          .update({ 
            invoice_created: true,
            invoice_id: invoiceData.id,
          })
          .eq('id', matchedPR.id);
      }
    }

    // Update drive_file_index to mark as processed
    await supabase
      .from('drive_file_index')
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        payment_request_id: matchedPR.id,
        invoice_id: invoiceId,
      })
      .eq('file_id', file.id);

    setFiles(prev => prev.map(f => 
      f.id === file.id ? { 
        ...f, 
        status: 'success', 
        message: `Khớp ${matchedPR.request_number}`,
        resultId: matchedPR.id 
      } : f
    ));
    setStats(prev => ({ ...prev, matched: prev.matched + 1 }));
  };

  const processBankSlipFile = async (
    file: FileStatus, 
    originalFile: any, 
    folderDate: string,
    token: string
  ): Promise<{ processed: boolean; pendingMatch?: PendingMatch; unmatched?: UnmatchedSlip }> => {
    // Scan bank slip
    const scanResponse = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-bank-slip`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          imageBase64: originalFile.base64,
          mimeType: originalFile.mimeType,
        }),
      }
    );

    if (!scanResponse.ok) {
      throw new Error('Không thể đọc thông tin UNC');
    }

    const scanData = await scanResponse.json();
    const slipData = scanData.data;

    if (!slipData.amount) {
      throw new Error('Không tìm thấy số tiền trong UNC');
    }

    // Find matching payment request
    // Include bank_account_name for matching
    const { data: unpaidRequests } = await supabase
      .from('payment_requests')
      .select('*, suppliers(id, name, bank_account_name)')
      .eq('status', 'approved')
      .eq('payment_status', 'unpaid');

    if (!unpaidRequests || unpaidRequests.length === 0) {
      // No unpaid PRs - return as unmatched to allow creating new PR
      const suggestedSupplier = findBestMatchingSupplier(slipData.recipient_name, allSuppliers);
      return {
        processed: false,
        unmatched: {
          file,
          originalFile,
          folderDate,
          slipData,
          suggestedSupplier,
        }
      };
    }

    const amountTolerance = slipData.amount * 0.01; // 1%
    const recipientLower = slipData.recipient_name?.toLowerCase() || '';

    // Find exact matches (amount + supplier name OR bank_account_name)
    const exactMatches = unpaidRequests.filter(pr => {
      const amountMatch = Math.abs((pr.total_amount || 0) - slipData.amount) <= amountTolerance;
      if (!amountMatch) return false;
      
      const supplierName = pr.suppliers?.name?.toLowerCase() || '';
      const bankAccountName = pr.suppliers?.bank_account_name?.toLowerCase() || '';
      
      const nameMatch = 
        (supplierName && (recipientLower.includes(supplierName) || supplierName.includes(recipientLower))) ||
        (bankAccountName && (recipientLower.includes(bankAccountName) || bankAccountName.includes(recipientLower)));
      
      return nameMatch;
    });

    if (exactMatches.length === 1) {
      // Perfect match → process as normal (with original file for image upload)
      await processMatchedPR(file, exactMatches[0], slipData, folderDate, originalFile);
      return { processed: true };
    }

    if (exactMatches.length > 1) {
      throw new Error(`Tìm thấy ${exactMatches.length} PR khớp, cần xử lý thủ công`);
    }

    // No exact match - find amount-only matches for confirmation
    const amountOnlyMatches = unpaidRequests.filter(pr => {
      const amountMatch = Math.abs((pr.total_amount || 0) - slipData.amount) <= amountTolerance;
      return amountMatch;
    });

    if (amountOnlyMatches.length === 1) {
      // Amount matches but name doesn't → ask for confirmation
      return { 
        processed: false, 
        pendingMatch: {
          file,
          originalFile,
          folderDate,
          slipData,
          matchedPR: amountOnlyMatches[0],
        }
      };
    }

    if (amountOnlyMatches.length > 1) {
      throw new Error(`Tìm thấy ${amountOnlyMatches.length} PR có cùng số tiền, cần xử lý thủ công`);
    }

    // No match at all - return as unmatched to allow creating new PR
    const suggestedSupplier = findBestMatchingSupplier(slipData.recipient_name, allSuppliers);
    return {
      processed: false,
      unmatched: {
        file,
        originalFile,
        folderDate,
        slipData,
        suggestedSupplier,
      }
    };
  };

  // Track if we're in the middle of PR creation flow to prevent unwanted resets
  const isInPRCreationFlow = phase === 'ask_pr_mode' || showManualPRDialog;
  
  useEffect(() => {
    let cancelled = false;
    
    if (open) {
      // Only reset if we're NOT in the middle of PR creation flow
      // This prevents the dialog from resetting after phase transitions
      if (!isInPRCreationFlow) {
        resetState();
        const timer = setTimeout(() => {
          if (!cancelled) {
            startImport();
          }
        }, 50);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }
    } else {
      // Reset when dialog closes to prepare for next open
      resetState();
    }
  }, [open, resetState, startImport, isInPRCreationFlow]);

  const getPhaseMessage = () => {
    switch (phase) {
      case 'checking_config':
        return 'Đang kiểm tra cấu hình...';
      case 'auto_scanning':
        return 'Đang quét tất cả folder PO...';
      case 'checking_today':
        return importType === 'po' 
          ? `Đang kiểm tra folder PO ngày ${formatFolderDate(currentDate)}...`
          : `Đang kiểm tra folder ngày ${currentDate}...`;
      case 'no_new_files_prompt':
        return importType === 'po' ? 'Không có PO mới hôm nay' : 'Không có file mới hôm nay';
      case 'loading_dates':
        return 'Đang tải danh sách ngày...';
      case 'select_dates':
        return 'Chọn ngày để cập nhật';
      case 'select_po_files':
        return `Phát hiện PO mới ngày ${formatFolderDate(currentDate)}`;
      case 'scanning_folder':
        return `Đang quét folder ngày ${currentDate}...`;
      case 'processing_files':
        return totalFilesToProcess > 0 
          ? `Đang xử lý ${processedCount}/${totalFilesToProcess} files...`
          : 'Đang xử lý files...';
      case 'confirm_supplier_name':
        return `Xác nhận NCC (${currentPendingIndex + 1}/${pendingMatches.length})`;
      case 'create_pr_from_unc':
        return `Tạo PR từ UNC (${currentUnmatchedIndex + 1}/${unmatchedSlips.length})`;
      case 'confirm_po_supplier':
        return `Xác nhận NCC cho PO (${currentUnmatchedPOIndex + 1}/${unmatchedPOFiles.length})`;
      case 'complete':
        return error ? 'Có lỗi xảy ra' : 'Hoàn tất';
      default:
        return '';
    }
  };

  const getStatusIcon = (status: FileStatus['status']) => {
    switch (status) {
      case 'pending':
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
      case 'processing':
        return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case 'success':
        return <CheckCircle2 className="h-4 w-4 text-primary" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'skipped':
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const hasResults = stats.created > 0 || stats.matched > 0;
  const totalSelectedFiles = selectionMode === 'all' 
    ? availableDates.reduce((sum, d) => sum + d.fileCount, 0)
    : availableDates.filter(d => selectedDates.includes(d.date)).reduce((sum, d) => sum + d.fileCount, 0);

  const isProcessing = ['checking_config', 'auto_scanning', 'checking_today', 'loading_dates', 'scanning_folder', 'processing_files'].includes(phase);

  // Calculate progress percentage
  const progressPercent = totalFilesToProcess > 0 
    ? Math.round((processedCount / totalFilesToProcess) * 100) 
    : 0;

  // Render different content based on phase
  const renderContent = () => {
    // Phase: No new files prompt
    if (phase === 'no_new_files_prompt') {
      return (
        <div className="text-center space-y-4 py-4">
          <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground" />
          <div className="space-y-2">
            <p className="text-sm">
              {importType === 'po' 
                ? `Không có PO mới trong folder ngày hôm nay (${formatFolderDate(currentDate)}).`
                : `Không có UNC mới trong folder ngày hôm nay (${formatFolderDate(currentDate)}).`
              }
            </p>
            <p className="text-sm font-medium">
              {importType === 'po'
                ? 'Bạn có muốn kiểm tra các ngày khác không?'
                : 'Bạn có muốn kiểm tra các đề nghị thanh toán chưa được cập nhật và quét UNC các ngày trước không?'
              }
            </p>
          </div>
        </div>
      );
    }

    // Phase: Select PO files (new)
    if (phase === 'select_po_files') {
      const newFilesCount = files.filter(f => f.status === 'pending').length;
      
      return (
        <div className="space-y-4">
          <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              <p className="font-medium">
                Phát hiện {newFilesCount} PO mới ngày {formatFolderDate(currentDate)}
              </p>
            </div>
          </div>

          <p className="text-sm font-medium">Bạn muốn quét những file nào?</p>
          
          <RadioGroup 
            value={poSelectionMode} 
            onValueChange={(v: 'all' | 'select') => setPOSelectionMode(v)}
            className="space-y-2"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="all" id="po-all" />
              <Label htmlFor="po-all" className="cursor-pointer">Quét tất cả ({newFilesCount} file)</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="select" id="po-select" />
              <Label htmlFor="po-select" className="cursor-pointer">Chọn từng file:</Label>
            </div>
          </RadioGroup>
          
          {poSelectionMode === 'select' && (
            <ScrollArea className="h-[200px] border rounded-lg p-3 ml-6">
              <div className="space-y-2">
                {files.filter(f => f.status === 'pending').map(file => (
                  <div key={file.id} className="flex items-center space-x-2">
                    <Checkbox 
                      id={`po-${file.id}`}
                      checked={selectedPOFiles.includes(file.id)}
                      onCheckedChange={(checked) => togglePOFile(file.id, checked === true)}
                    />
                    <Label htmlFor={`po-${file.id}`} className="text-sm cursor-pointer flex items-center gap-2">
                      <FileImage className="h-3 w-3 text-muted-foreground" />
                      {file.name}
                    </Label>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      );
    }

    // Phase: Select dates (for bank_slip when checking other dates, or for PO fallback)
    if (phase === 'select_dates') {
      const itemLabel = importType === 'po' ? 'PO' : 'UNC';
      return (
        <div className="space-y-4">
          {/* Summary of available files */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Hiện có:</p>
            <ul className="text-sm space-y-1 ml-2">
              {availableDates.map(d => (
                <li key={d.date} className="flex items-center gap-2">
                  <FileImage className="h-3 w-3 text-muted-foreground" />
                  <span><strong>{d.fileCount}</strong> {itemLabel} ngày {formatFolderDate(d.date)}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-sm font-medium pt-2">Bạn muốn {importType === 'po' ? 'quét' : 'cập nhật'} ngày nào?</p>
          
          <div className="space-y-3">
            <RadioGroup 
              value={selectionMode} 
              onValueChange={(v: 'all' | 'select') => setSelectionMode(v)}
              className="space-y-2"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="mode-all" />
                <Label htmlFor="mode-all" className="cursor-pointer">
                  {importType === 'po' ? 'Quét' : 'Cập nhật'} tất cả ({availableDates.reduce((sum, d) => sum + d.fileCount, 0)} file)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="select" id="mode-select" />
                <Label htmlFor="mode-select" className="cursor-pointer">
                  Chọn từng ngày:
                </Label>
              </div>
            </RadioGroup>
            
            {selectionMode === 'select' && (
              <ScrollArea className="h-[200px] border rounded-lg p-3 ml-6">
                <div className="space-y-2">
                  {availableDates.map(item => (
                    <div key={item.date} className="flex items-center space-x-2">
                      <Checkbox 
                        id={`date-${item.date}`}
                        checked={selectedDates.includes(item.date)}
                        onCheckedChange={(checked) => toggleDate(item.date, checked)}
                      />
                      <Label 
                        htmlFor={`date-${item.date}`}
                        className="text-sm cursor-pointer flex items-center gap-2"
                      >
                        <FileImage className="h-3 w-3 text-muted-foreground" />
                        Ngày {formatFolderDate(item.date)} ({item.fileCount} file)
                      </Label>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      );
    }

    // Phase: Confirm supplier name
    if (phase === 'confirm_supplier_name' && pendingMatches.length > 0) {
      const current = pendingMatches[currentPendingIndex];
      const pr = current.matchedPR;
      
      return (
        <div className="space-y-4 py-4">
          <div className="p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-2 flex-1">
                <p className="font-medium">UNC khớp số tiền nhưng khác tên NCC</p>
                <div className="text-sm space-y-1">
                  <p><strong>Số tiền:</strong> {current.slipData.amount?.toLocaleString()}đ ✓</p>
                  <p><strong>Tên trên UNC:</strong> {current.slipData.recipient_name}</p>
                  <p><strong>Tên NCC trong hệ thống:</strong> {pr.suppliers?.name}</p>
                  <p><strong>Mã PR:</strong> {pr.request_number}</p>
                </div>
              </div>
            </div>
          </div>
          
          <p className="text-sm text-center">
            Xác nhận đây là thanh toán của <strong>{pr.suppliers?.name}</strong>?
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Nếu đồng ý, tên "<strong>{current.slipData.recipient_name}</strong>" sẽ được lưu vào NCC để tự động khớp lần sau.
          </p>
        </div>
      );
    }

    // Phase: Confirm/Create supplier for PO
    if (phase === 'confirm_po_supplier' && unmatchedPOFiles.length > 0) {
      const current = unmatchedPOFiles[currentUnmatchedPOIndex];
      
      return (
        <div className="space-y-4 py-4">
          <div className="p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-2 flex-1">
                <p className="font-medium">PO có tên thanh toán nhưng không tìm thấy NCC</p>
                <div className="text-sm space-y-1">
                  <p><strong>File:</strong> {current.file.name}</p>
                  <p><strong>Tên trên PO:</strong> {current.supplierName}</p>
                  {current.poData?.total_amount && (
                    <p><strong>Số tiền:</strong> {current.poData.total_amount.toLocaleString()}đ</p>
                  )}
                  {current.suggestedSupplier && (
                    <p className="text-amber-700 dark:text-amber-400">
                      <strong>Gợi ý:</strong> {current.suggestedSupplier.name} ({Math.round(current.suggestedSupplier.matchScore * 100)}% khớp)
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <p className="text-sm font-medium">Bạn muốn làm gì?</p>
          
          <RadioGroup 
            value={poSupplierAction} 
            onValueChange={(v: 'select' | 'create') => {
              setPOSupplierAction(v);
              // Prefill form when switching to create mode
              if (v === 'create') {
                const name = current.supplierName !== '(Không xác định)' ? current.supplierName : '';
                setNewSupplierName(name);
              }
            }}
            className="space-y-3"
          >
            {/* Option 1: Select existing supplier */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="select" id="po-select-supplier" />
                <Label htmlFor="po-select-supplier" className="cursor-pointer font-medium">
                  Chọn NCC có sẵn
                </Label>
              </div>
              
              {/* Nested dropdown - only show when "select" is chosen */}
              {poSupplierAction === 'select' && (
                <div className="space-y-3 ml-6 p-3 border rounded-lg bg-muted/30">
                  <Select 
                    value={selectedPOSupplierId || '_none'} 
                    onValueChange={(v) => setSelectedPOSupplierId(v === '_none' ? null : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn NCC..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">-- Chọn NCC --</SelectItem>
                      {current.suggestedSupplier && (
                        <SelectItem value={current.suggestedSupplier.id}>
                          ★ {current.suggestedSupplier.name} (gợi ý)
                        </SelectItem>
                      )}
                      {allSuppliers
                        .filter(s => s.id !== current.suggestedSupplier?.id)
                        .map(s => (
                          <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                        ))
                      }
                    </SelectContent>
                  </Select>

                  {selectedPOSupplierId && current.supplierName !== '(Không xác định)' && (
                    <div className="flex items-start space-x-2">
                      <Checkbox 
                        id="save-po-bank-name" 
                        checked={savePOBankName}
                        onCheckedChange={(checked) => setSavePOBankName(checked === true)}
                      />
                      <Label htmlFor="save-po-bank-name" className="text-sm cursor-pointer leading-tight">
                        Lưu "<strong>{current.supplierName}</strong>" làm tên thanh toán
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          (Để tự động khớp lần sau)
                        </span>
                      </Label>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Option 2: Create new supplier */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="create" id="po-create-supplier" />
                <Label htmlFor="po-create-supplier" className="cursor-pointer font-medium">
                  Tạo NCC mới
                </Label>
              </div>
              
              {/* Nested form - only show when "create" is chosen */}
              {poSupplierAction === 'create' && (
                <div className="space-y-3 ml-6 p-3 border rounded-lg bg-muted/30">
                  <div className="space-y-1.5">
                    <Label htmlFor="new-supplier-name" className="text-sm">Tên NCC <span className="text-destructive">*</span></Label>
                    <Input
                      id="new-supplier-name"
                      value={newSupplierName}
                      onChange={(e) => setNewSupplierName(e.target.value)}
                      placeholder="Nhập tên nhà cung cấp..."
                    />
                  </div>
                  
                  <div className="space-y-1.5">
                    <Label htmlFor="new-supplier-phone" className="text-sm">Số điện thoại</Label>
                    <Input
                      id="new-supplier-phone"
                      value={newSupplierPhone}
                      onChange={(e) => setNewSupplierPhone(e.target.value)}
                      placeholder="(Tùy chọn)"
                    />
                  </div>
                  
                  <div className="space-y-1.5">
                    <Label className="text-sm">Phương thức thanh toán</Label>
                    <RadioGroup
                      value={newSupplierPaymentMethod}
                      onValueChange={(v: 'bank_transfer' | 'cash') => setNewSupplierPaymentMethod(v)}
                      className="flex gap-4"
                    >
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="bank_transfer" id="payment-unc" />
                        <Label htmlFor="payment-unc" className="cursor-pointer text-sm">Chuyển khoản</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="cash" id="payment-cash" />
                        <Label htmlFor="payment-cash" className="cursor-pointer text-sm">Tiền mặt</Label>
                      </div>
                    </RadioGroup>
                  </div>
                </div>
              )}
            </div>
          </RadioGroup>

          {/* VAT Learning Checkbox - for both create and select modes */}
          <div className="p-3 border rounded-lg bg-muted/30">
            <div className="flex items-start space-x-2">
              <Checkbox 
                id="vat-included" 
                checked={vatIncludedChoice === true}
                onCheckedChange={(checked) => setVatIncludedChoice(checked === true ? true : null)}
              />
              <Label htmlFor="vat-included" className="text-sm cursor-pointer leading-tight">
                NCC này có giá đã bao gồm VAT (không có dòng VAT riêng)
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Lưu để các lần scan sau tự động bỏ qua VAT
                </span>
              </Label>
            </div>
          </div>

          {unmatchedPOFiles.length > 1 && (
            <p className="text-xs text-muted-foreground text-center">
              File {currentUnmatchedPOIndex + 1}/{unmatchedPOFiles.length}
            </p>
          )}
        </div>
      );
    }

    // Phase: Ask PR creation mode (after PO created)
    if (phase === 'ask_pr_mode' && pendingPOForPR) {
      return (
        <div className="space-y-4 py-4">
          <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">Đã tạo {pendingPOForPR.poNumber} thành công!</p>
                <div className="text-sm text-muted-foreground space-y-0.5">
                  <p>NCC: {pendingPOForPR.supplierName || 'Chưa xác định'}</p>
                  {pendingPOForPR.poData?.total_amount && (
                    <p>Số tiền: {pendingPOForPR.poData.total_amount.toLocaleString()}đ</p>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <p className="text-sm font-medium">Bạn muốn tạo đề nghị thanh toán (PR) như thế nào?</p>
          
          <RadioGroup 
            value={prCreationMode} 
            onValueChange={(v: 'auto' | 'manual') => setPRCreationMode(v)}
            className="space-y-2"
          >
            <div className="flex items-start space-x-2 p-3 border rounded-lg hover:bg-muted/50 transition-colors">
              <RadioGroupItem value="auto" id="pr-auto" className="mt-0.5" />
              <Label htmlFor="pr-auto" className="cursor-pointer flex-1">
                <span className="font-medium">Tạo tự động</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Hệ thống tự tạo PR với thông tin từ PO
                </span>
              </Label>
            </div>
            <div className="flex items-start space-x-2 p-3 border rounded-lg hover:bg-muted/50 transition-colors">
              <RadioGroupItem value="manual" id="pr-manual" className="mt-0.5" />
              <Label htmlFor="pr-manual" className="cursor-pointer flex-1">
                <span className="font-medium">Nhập thủ công</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Mở form tạo PR để bạn chỉnh sửa trước khi lưu
                </span>
              </Label>
            </div>
          </RadioGroup>

          {/* Show queue progress indicator */}
          {pendingPOQueue.length > 1 && (
            <p className="text-xs text-muted-foreground text-center">
              PO {pendingPOQueue.length - pendingPOQueue.indexOf(pendingPOForPR)}/{pendingPOQueue.length + stats.created} đã xử lý
            </p>
          )}
        </div>
      );
    }

    // Fallback: ask_pr_mode phase but queue not ready yet (race condition safety)
    if (phase === 'ask_pr_mode' && !pendingPOForPR) {
      return (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin mr-2" />
          <span>Đang chuẩn bị...</span>
        </div>
      );
    }

    // Phase: Create PR from unmatched UNC
    if (phase === 'create_pr_from_unc' && unmatchedSlips.length > 0) {
      const current = unmatchedSlips[currentUnmatchedIndex];
      
      return (
        <div className="space-y-4 py-4">
          <div className="p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-3">
              <Plus className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="space-y-2 flex-1">
                <p className="font-medium">UNC không tìm thấy PR khớp</p>
                <div className="text-sm space-y-1">
                  <p><strong>Số tiền:</strong> {current.slipData.amount?.toLocaleString()}đ</p>
                  <p><strong>Tên người nhận:</strong> {current.slipData.recipient_name}</p>
                  {current.slipData.transaction_date && (
                    <p><strong>Ngày GD:</strong> {current.slipData.transaction_date}</p>
                  )}
                  {current.suggestedSupplier && (
                    <p className="text-blue-600">
                      <strong>Gợi ý NCC:</strong> {current.suggestedSupplier.name} ({Math.round(current.suggestedSupplier.matchScore * 100)}% khớp)
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
          
          <p className="text-sm font-medium">Bạn muốn làm gì với UNC này?</p>
          
          <RadioGroup 
            value={actionMode} 
            onValueChange={(v: 'create_pr' | 'skip') => setActionMode(v)}
            className="space-y-2"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="create_pr" id="create-pr" />
              <Label htmlFor="create-pr" className="cursor-pointer">
                Tạo đề nghị thanh toán mới (đã duyệt + đã thanh toán)
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="skip" id="skip-unc" />
              <Label htmlFor="skip-unc" className="cursor-pointer">
                Bỏ qua UNC này
              </Label>
            </div>
          </RadioGroup>

          {actionMode === 'create_pr' && (
            <div className="space-y-3 ml-6 p-3 border rounded-lg bg-muted/30">
              <p className="text-sm font-medium">Chọn nhà cung cấp:</p>
              
              <Select 
                value={selectedSupplierId || '_none'} 
                onValueChange={(v) => setSelectedSupplierId(v === '_none' ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Chọn NCC..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">-- Chọn NCC --</SelectItem>
                  {current.suggestedSupplier && (
                    <SelectItem value={current.suggestedSupplier.id}>
                      ★ {current.suggestedSupplier.name} (gợi ý)
                    </SelectItem>
                  )}
                  {allSuppliers
                    .filter(s => s.id !== current.suggestedSupplier?.id)
                    .map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))
                  }
                </SelectContent>
              </Select>

              {selectedSupplierId && (
                <div className="flex items-start space-x-2">
                  <Checkbox 
                    id="update-bank-name" 
                    checked={updateBankName}
                    onCheckedChange={(checked) => setUpdateBankName(checked === true)}
                  />
                  <Label htmlFor="update-bank-name" className="text-sm cursor-pointer leading-tight">
                    Lưu "<strong>{current.slipData.recipient_name}</strong>" làm tên thanh toán của NCC này
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      (Để tự động khớp lần sau)
                    </span>
                  </Label>
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    // Phase: Loading/Processing states with spinner and progress bar
    if (phase === 'loading_dates' || phase === 'auto_scanning') {
      return (
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{getPhaseMessage()}</p>
        </div>
      );
    }

    // Phase: Processing files with progress bar
    if (phase === 'processing_files' && totalFilesToProcess > 0) {
      return (
        <div className="space-y-4">
          {/* Progress bar */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Đang xử lý...</span>
              <span>{processedCount}/{totalFilesToProcess} ({progressPercent}%)</span>
            </div>
            <Progress value={progressPercent} className="h-2" />
          </div>

          {/* File list */}
          <ScrollArea className="h-[250px] border rounded-lg p-2">
            <div className="space-y-2">
              {files.map((file) => (
                <div 
                  key={file.id}
                  className="flex items-center gap-3 p-2 rounded-lg bg-muted/50"
                >
                  <FileImage className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    {file.message && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <ArrowRight className="h-3 w-3" />
                        {file.message}
                      </p>
                    )}
                  </div>
                  {getStatusIcon(file.status)}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      );
    }

    // Standard content for other phases
    return (
      <>
        {error && phase === 'complete' && (
          error === 'Chưa có UNC để cập nhật' || error === 'Không có file PO mới để import' ? (
            <div className="text-center space-y-4 py-4">
              <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {error}
              </p>
            </div>
          ) : (
            <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">
              {error}
            </div>
          )
        )}

        {files.length > 0 && phase === 'complete' && (
          <ScrollArea className="h-[300px] border rounded-lg p-2">
            <div className="space-y-2">
              {files.map((file) => (
                <div 
                  key={file.id}
                  className="flex items-center gap-3 p-2 rounded-lg bg-muted/50"
                >
                  <FileImage className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    {file.message && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <ArrowRight className="h-3 w-3" />
                        {file.message}
                      </p>
                    )}
                  </div>
                  {getStatusIcon(file.status)}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {phase === 'complete' && !error && (
          <div className="text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 mx-auto text-primary" />
            <p className="text-lg font-medium">
              {importType === 'po' 
                ? `Đã tạo ${stats.created} đơn đặt hàng + đề nghị thanh toán!`
                : stats.created > 0 
                  ? `Đã cập nhật ${stats.matched} và tạo mới ${stats.created} đề nghị thanh toán!`
                  : `Đã cập nhật ${stats.matched} đề nghị thanh toán thành công!`
              }
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {importType === 'po' ? (
                <>
                  <Badge variant="secondary">PO: {stats.created}</Badge>
                  <Badge variant="default">PR: {stats.created}</Badge>
                </>
              ) : (
                <>
                  <Badge variant="secondary">Khớp thanh toán: {stats.matched}</Badge>
                  {stats.created > 0 && (
                    <Badge variant="default">Tạo mới: {stats.created}</Badge>
                  )}
                </>
              )}
              {stats.skipped > 0 && (
                <Badge variant="outline">Bỏ qua: {stats.skipped}</Badge>
              )}
              {stats.failed > 0 && (
                <Badge variant="destructive">Lỗi: {stats.failed}</Badge>
              )}
            </div>
          </div>
        )}

        {(phase === 'checking_config' || phase === 'checking_today' || phase === 'scanning_folder') && files.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{getPhaseMessage()}</p>
          </div>
        )}
      </>
    );
  };

  // Render footer buttons based on phase
  const renderFooter = () => {
    if (phase === 'no_new_files_prompt') {
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose()}>
            Hủy
          </Button>
          <Button onClick={importType === 'po' ? loadAllDatesPO : loadAllDates}>
            <Search className="h-4 w-4 mr-2" />
            Kiểm tra các ngày khác
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'select_po_files') {
      const selectedCount = poSelectionMode === 'all' 
        ? files.filter(f => f.status === 'pending').length
        : selectedPOFiles.length;
        
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose()}>
            Hủy
          </Button>
          <Button 
            onClick={startProcessingSelectedPO}
            disabled={selectedCount === 0}
          >
            Quét {selectedCount} file
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'select_dates') {
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onClose()}>
            Hủy
          </Button>
          <Button 
            onClick={importType === 'po' ? startProcessingSelectedDatesPO : startProcessingSelected}
            disabled={selectionMode === 'select' && selectedDates.length === 0}
          >
            {importType === 'po' ? 'Quét' : 'Cập nhật'} {selectionMode === 'all' ? 'tất cả' : `${selectedDates.length} ngày`}
            {totalSelectedFiles > 0 && ` (${totalSelectedFiles} file)`}
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'confirm_supplier_name') {
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSkipSupplierMatch} disabled={isConfirming}>
            Bỏ qua
          </Button>
          <Button onClick={handleConfirmSupplierMatch} disabled={isConfirming}>
            {isConfirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xử lý...
              </>
            ) : (
              'Xác nhận đúng'
            )}
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'confirm_po_supplier') {
      const canConfirm = poSupplierAction === 'create' || selectedPOSupplierId;
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSkipPOFile} disabled={isConfirming}>
            Bỏ qua
          </Button>
          <Button onClick={handleConfirmPOSupplier} disabled={!canConfirm || isConfirming}>
            {isConfirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xử lý...
              </>
            ) : poSupplierAction === 'create' ? (
              <>
                <Plus className="h-4 w-4 mr-2" />
                Tạo NCC & PO
              </>
            ) : (
              'Xác nhận'
            )}
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'ask_pr_mode') {
      return (
        <DialogFooter className="gap-2">
          <Button onClick={handlePRModeConfirm} disabled={isConfirming}>
            {isConfirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xử lý...
              </>
            ) : prCreationMode === 'auto' ? (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Tạo PR tự động
              </>
            ) : (
              <>
                <ArrowRight className="h-4 w-4 mr-2" />
                Mở form tạo PR
              </>
            )}
          </Button>
        </DialogFooter>
      );
    }

    if (phase === 'create_pr_from_unc') {
      return (
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleSkipUnmatched} disabled={isConfirming}>
            Bỏ qua
          </Button>
          <Button 
            onClick={actionMode === 'create_pr' ? handleCreatePRFromUNC : handleSkipUnmatched} 
            disabled={isConfirming || (actionMode === 'create_pr' && !selectedSupplierId)}
          >
            {isConfirming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xử lý...
              </>
            ) : actionMode === 'create_pr' ? (
              <>
                <Plus className="h-4 w-4 mr-2" />
                Tạo PR & Hoá đơn
              </>
            ) : (
              'Tiếp tục'
            )}
          </Button>
        </DialogFooter>
      );
    }

    // Processing phases - show cancel button
    if (phase === 'processing_files' || phase === 'checking_today' || phase === 'scanning_folder' || phase === 'checking_config' || phase === 'auto_scanning' || phase === 'loading_dates') {
      return (
        <DialogFooter className="gap-2">
          <Button 
            variant="outline" 
            onClick={() => onClose(false)}
          >
            Hủy
          </Button>
          <Button disabled>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Đang xử lý...
          </Button>
        </DialogFooter>
      );
    }

    return (
      <DialogFooter>
        <Button onClick={() => onClose(hasResults)}>
          {phase === 'complete' ? 'Đóng' : 'Đang xử lý...'}
        </Button>
      </DialogFooter>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={() => onClose(hasResults)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5" />
              {importType === 'po' ? 'Tạo PO từ Google Drive' : 'Kiểm tra Bank slip mới'}
            </DialogTitle>
            <DialogDescription>
              {getPhaseMessage()}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {renderContent()}
          </div>

          {renderFooter()}
        </DialogContent>
      </Dialog>
      
      {/* Manual PR Creation Dialog */}
      {showManualPRDialog && manualPRDialogData && (
        <AddPaymentRequestDialog
          open={showManualPRDialog}
          onOpenChange={(open) => {
            setShowManualPRDialog(open);
            if (!open) {
              setManualPRDialogData(null);
            }
          }}
          prefillData={manualPRDialogData as PRPrefillData}
        />
      )}
    </>
  );
}
