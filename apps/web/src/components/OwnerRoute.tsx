import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { PageLoader } from "@/components/ui/loading";

/**
 * Route guard that only allows access to users with the "owner" role.
 * Redirects all other authenticated users to the home page.
 */
export function OwnerRoute({ children }: { children: React.ReactNode }) {
  const { loading, isOwner, user } = useAuth();

  if (loading) {
    return (
      <PageLoader className="min-h-[50vh]" />
    );
  }

  if (!user || !isOwner) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
