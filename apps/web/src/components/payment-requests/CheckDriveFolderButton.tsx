import { useState } from "react";
import { FolderSearch, FileText, CreditCard, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DriveImportProgressDialog } from "./DriveImportProgressDialog";

interface CheckDriveFolderButtonProps {
  onImportComplete?: () => void;
}

export function CheckDriveFolderButton({ onImportComplete }: CheckDriveFolderButtonProps) {
  const [showDialog, setShowDialog] = useState(false);
  const [importType, setImportType] = useState<'po' | 'bank_slip'>('po');

  const handleCheckPO = () => {
    setImportType('po');
    setShowDialog(true);
  };

  const handleCheckBankSlip = () => {
    setImportType('bank_slip');
    setShowDialog(true);
  };

  const handleDialogClose = (success?: boolean) => {
    setShowDialog(false);
    if (success && onImportComplete) {
      onImportComplete();
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <FolderSearch className="h-4 w-4 mr-2" />
            Kiểm tra Drive
            <ChevronDown className="h-4 w-4 ml-2" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleCheckPO}>
            <FileText className="h-4 w-4 mr-2" />
            Kiểm tra PO mới
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCheckBankSlip}>
            <CreditCard className="h-4 w-4 mr-2" />
            Kiểm tra Bank slip mới
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DriveImportProgressDialog
        open={showDialog}
        onClose={handleDialogClose}
        importType={importType}
      />
    </>
  );
}
