import { useState } from "react";
import { Phone, Mail } from "lucide-react";
import { useSuppliers, Supplier } from "@/hooks/useSuppliers";
import { Skeleton } from "@/components/ui/skeleton";
import { SupplierDetailsDialog } from "@/components/dialogs/SupplierDetailsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";


export function SupplierList() {
  const { data: suppliers, isLoading, isError, error, refetch } = useSuppliers();
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const normalizeText = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const filteredSuppliers = suppliers?.filter((supplier) =>
    normalizeText(supplier.name).includes(normalizeText(searchTerm))
  );

  const handleSupplierClick = (supplier: Supplier) => {
    setSelectedSupplier(supplier);
    setDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="card-elevated rounded-xl border border-border p-6">
        <h3 className="font-display text-lg font-semibold mb-4">Suppliers</h3>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Top Suppliers</h3>
          <p className="text-sm text-muted-foreground">Your trusted partners</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="font-medium text-foreground">Couldn't load suppliers</p>
          <p className="text-sm text-muted-foreground break-words">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!suppliers?.length) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Top Suppliers</h3>
          <p className="text-sm text-muted-foreground">Your trusted partners</p>
        </div>
        <p className="text-muted-foreground text-center py-8">
          No suppliers yet. Add your first supplier to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border space-y-3">
          <div>
            <h3 className="font-display text-lg font-semibold">Top Suppliers</h3>
            <p className="text-sm text-muted-foreground">Your trusted partners</p>
          </div>
          <Input
            placeholder="Search suppliers by name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="divide-y divide-border">
          {filteredSuppliers?.length ? filteredSuppliers.map((supplier) => (
            <div
              key={supplier.id}
              className="flex items-center justify-between px-6 py-4 hover:bg-muted/30 transition-colors cursor-pointer"
              onClick={() => handleSupplierClick(supplier)}
            >
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <span className="text-lg font-display font-bold text-primary">
                    {supplier.name.charAt(0)}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{supplier.name}</p>
                  <p className="text-sm text-muted-foreground">{supplier.category}</p>
                  {supplier.description && (
                    <p className="text-sm text-muted-foreground mt-1 truncate max-w-md">
                      {supplier.description}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-6">
                {supplier.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{supplier.phone}</span>
                  </div>
                )}
                {supplier.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{supplier.email}</span>
                  </div>
                )}
              </div>
            </div>
          )) : (
            <p className="text-muted-foreground text-center py-8">No matching suppliers found.</p>
          )}
        </div>
      </div>
      
      <SupplierDetailsDialog 
        supplier={selectedSupplier} 
        open={dialogOpen} 
        onOpenChange={setDialogOpen} 
      />
    </>
  );
}
