import { useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import ControllerDashboard from "./ControllerDashboard";

export default function MaterialMasterSystemStatus() {
  const { canAccessModule, canEditModule } = useAuth();
  const canView = canAccessModule("material_master");
  const canEdit = canEditModule("material_master");
  const [sourceFilter, setSourceFilter] = useState("all");

  if (!canView) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Không có quyền truy cập</AlertTitle>
          <AlertDescription>Trang trạng thái hệ thống yêu cầu quyền xem Quản trị NVL.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-3 sm:p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/material-master"><ArrowLeft className="mr-2 h-4 w-4" />Quay lại danh mục NVL</Link>
        </Button>
        <ControllerDashboard sourceFilter={sourceFilter} onSourceFilterChange={setSourceFilter} canEdit={canEdit} />
      </div>
    </div>
  );
}
