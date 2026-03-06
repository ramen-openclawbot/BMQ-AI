import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";

/**
 * Route guard that only allows access to users with the "owner" role.
 * Redirects all other authenticated users to the home page.
 */
export function OwnerRoute({ children }: { children: React.ReactNode }) {
  const { loading, isOwner, user } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user || !isOwner) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
