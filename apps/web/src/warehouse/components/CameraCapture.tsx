import { useRef, useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Camera, RotateCcw, Check, X, ImagePlus } from "lucide-react";

interface CameraCaptureProps {
  onCapture: (imageData: string) => void;
  onCancel?: () => void;
  label?: string;
  aspectRatio?: "4:3" | "16:9" | "1:1";
}

export function CameraCapture({ 
  onCapture, 
  onCancel,
  label = "Chụp ảnh",
  aspectRatio = "4:3"
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const aspectRatioClass = {
    "4:3": "aspect-[4/3]",
    "16:9": "aspect-video",
    "1:1": "aspect-square",
  }[aspectRatio];

  const startCamera = useCallback(async () => {
    setIsStarting(true);
    setCameraError(null);
    
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      
      setStream(mediaStream);
      
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
    } catch (err) {
      console.error("Camera error:", err);
      setCameraError("Không thể truy cập camera. Vui lòng cho phép quyền camera hoặc sử dụng chức năng chọn ảnh.");
    } finally {
      setIsStarting(false);
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  }, [stream]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    
    if (!context) return;

    // Set canvas size to video size
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert to compressed JPEG
    const imageData = canvas.toDataURL("image/jpeg", 0.8);
    setCapturedImage(imageData);
    stopCamera();
  }, [stopCamera]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      
      // Compress image using canvas
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Max dimensions
        const maxWidth = 1920;
        const maxHeight = 1080;
        let { width, height } = img;

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width *= ratio;
          height *= ratio;
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);
        
        const compressed = canvas.toDataURL("image/jpeg", 0.8);
        setCapturedImage(compressed);
        stopCamera();
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  }, [stopCamera]);

  const retakePhoto = useCallback(() => {
    setCapturedImage(null);
    startCamera();
  }, [startCamera]);

  const confirmPhoto = useCallback(() => {
    if (capturedImage) {
      onCapture(capturedImage);
    }
  }, [capturedImage, onCapture]);

  const handleCancel = useCallback(() => {
    stopCamera();
    setCapturedImage(null);
    onCancel?.();
  }, [stopCamera, onCancel]);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h3 className="font-medium text-lg">{label}</h3>
      </div>

      <div className={`relative bg-muted rounded-lg overflow-hidden ${aspectRatioClass}`}>
        {capturedImage ? (
          <img 
            src={capturedImage} 
            alt="Captured" 
            className="w-full h-full object-cover"
          />
        ) : cameraError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
            <Camera className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4">{cameraError}</p>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="h-4 w-4 mr-2" />
              Chọn ảnh từ thư viện
            </Button>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        )}
        
        {isStarting && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      <div className="flex gap-3 justify-center">
        {capturedImage ? (
          <>
            <Button
              variant="outline"
              size="lg"
              onClick={retakePhoto}
              className="flex-1"
            >
              <RotateCcw className="h-5 w-5 mr-2" />
              Chụp lại
            </Button>
            <Button
              size="lg"
              onClick={confirmPhoto}
              className="flex-1"
            >
              <Check className="h-5 w-5 mr-2" />
              Xác nhận
            </Button>
          </>
        ) : (
          <>
            {onCancel && (
              <Button
                variant="outline"
                size="lg"
                onClick={handleCancel}
              >
                <X className="h-5 w-5 mr-2" />
                Hủy
              </Button>
            )}
            {!cameraError && stream && (
              <Button
                size="lg"
                onClick={capturePhoto}
                className="flex-1"
              >
                <Camera className="h-5 w-5 mr-2" />
                Chụp
              </Button>
            )}
            <Button
              variant="outline"
              size="lg"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImagePlus className="h-5 w-5 mr-2" />
              Thư viện
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
