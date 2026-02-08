import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { db } from "@/lib/supabase-helpers";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import ExcelJS from "exceljs";

interface ImportedSupplier {
  Name: string;
  Category?: string;
  Description?: string;
  Phone?: string;
  Email?: string;
}

export function ImportSuppliersButton() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [previewData, setPreviewData] = useState<ImportedSupplier[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(arrayBuffer);
      
      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        console.error("No worksheet found in the file");
        return;
      }

      const jsonData: ImportedSupplier[] = [];
      const headers: string[] = [];

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
          // Get headers from first row
          row.eachCell((cell) => {
            headers.push(String(cell.value || ""));
          });
        } else {
          // Parse data rows
          const rowData: Record<string, string> = {};
          row.eachCell((cell, colNumber) => {
            const header = headers[colNumber - 1];
            if (header) {
              rowData[header] = String(cell.value || "");
            }
          });
          
          if (rowData.Name) {
            jsonData.push({
              Name: rowData.Name,
              Category: rowData.Category,
              Description: rowData.Description,
              Phone: rowData.Phone,
              Email: rowData.Email,
            });
          }
        }
      });

      if (jsonData.length === 0) {
        console.error("No data found in the file");
        return;
      }

      // Validate required fields
      const invalidRows = jsonData.filter((row) => !row.Name);
      if (invalidRows.length > 0) {
        console.error("Some rows are missing the Name field");
        return;
      }

      setPreviewData(jsonData);
      setIsDialogOpen(true);
    } catch (error) {
      console.error("Parse error:", error);
    }

    // Reset input so the same file can be selected again
    event.target.value = "";
  };

  const handleImport = async () => {
    // PROTOTYPE MODE: No login required
    setIsImporting(true);
    try {
      const suppliersToInsert = previewData.map((row) => ({
        name: row.Name,
        category: row.Category || null,
        description: row.Description || null,
        phone: row.Phone || null,
        email: row.Email || null,
        created_by: user?.id || null,
      }));

      const { error } = await db.from("suppliers").insert(suppliersToInsert);

      if (error) throw error;

      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      setIsDialogOpen(false);
      setPreviewData([]);
    } catch (error: any) {
      console.error("Import error:", error);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={handleFileSelect}
        className="hidden"
      />
      <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
        <Upload className="h-4 w-4 mr-2" />
        Import
      </Button>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Import Suppliers</DialogTitle>
            <DialogDescription>
              Review the data before importing. {previewData.length} suppliers
              will be added.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium">Name</th>
                  <th className="text-left p-2 font-medium">Category</th>
                  <th className="text-left p-2 font-medium">Phone</th>
                  <th className="text-left p-2 font-medium">Email</th>
                </tr>
              </thead>
              <tbody>
                {previewData.slice(0, 50).map((row, index) => (
                  <tr key={index} className="border-t">
                    <td className="p-2">{row.Name}</td>
                    <td className="p-2">{row.Category || "-"}</td>
                    <td className="p-2">{row.Phone || "-"}</td>
                    <td className="p-2">{row.Email || "-"}</td>
                  </tr>
                ))}
                {previewData.length > 50 && (
                  <tr className="border-t">
                    <td
                      colSpan={4}
                      className="p-2 text-center text-muted-foreground"
                    >
                      ... and {previewData.length - 50} more
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
              disabled={isImporting}
            >
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={isImporting}>
              {isImporting ? "Importing..." : `Import ${previewData.length} Suppliers`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
