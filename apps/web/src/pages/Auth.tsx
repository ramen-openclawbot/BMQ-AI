import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { lovable, handleOAuthCallback } from "@/integrations/lovable/index";
import { useAuth } from "@/contexts/AuthContext";
import bmqLogo from "@/assets/bmq-logo.png";

// Google Icon component
const GoogleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </svg>
);

export default function Auth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processingCallback, setProcessingCallback] = useState(true);
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // Handle OAuth callback on page load
  useEffect(() => {
    async function processCallback() {
      const result = await handleOAuthCallback();
      
      if (result.handled) {
        if (result.error) {
          console.error("OAuth callback error:", result.error);
          setError("Đăng nhập thất bại. Vui lòng thử lại.");
          setProcessingCallback(false);
        } else {
          // Success - wait a moment for AuthContext to sync before navigating
          // This prevents race conditions where navigate happens before auth state updates
          await new Promise(resolve => setTimeout(resolve, 200));
          navigate("/", { replace: true });
          return;
        }
      } else {
        setProcessingCallback(false);
      }
    }
    
    processCallback();
  }, [navigate]);

  // Redirect if already logged in
  useEffect(() => {
    if (user && !authLoading && !processingCallback) {
      navigate("/", { replace: true });
    }
  }, [user, authLoading, processingCallback, navigate]);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    
    const { error } = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}/auth`,
      extraParams: {
        hd: "bmq.vn", // Chỉ cho phép domain @bmq.vn
      },
    });
    
    if (error) {
      console.error("Google OAuth error:", error);
      setError("Đã xảy ra lỗi. Vui lòng thử lại.");
      setLoading(false);
    }
    // Nếu thành công, browser sẽ redirect sang Google
  };

  // Show loading while processing OAuth callback or checking auth
  if (processingCallback || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <img src={bmqLogo} alt="BMQ Logo" className="h-16 mx-auto mb-4" />
          <h1 className="text-2xl font-display font-bold text-foreground">
            BMQ Procurement
          </h1>
          <p className="text-muted-foreground mt-2">
            Đăng nhập bằng tài khoản Google @bmq.vn
          </p>
        </div>
        
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        
        <Button 
          onClick={handleGoogleLogin} 
          disabled={loading}
          className="w-full"
          size="lg"
          variant="outline"
        >
          {loading ? (
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          ) : (
            <GoogleIcon className="mr-2 h-5 w-5" />
          )}
          Đăng nhập bằng Google
        </Button>
        
        <p className="text-xs text-muted-foreground">
          Chỉ hỗ trợ email @bmq.vn
        </p>
      </div>
    </div>
  );
}
