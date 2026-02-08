import { Button } from "@/components/ui/button";
import { Check, X, Camera } from "lucide-react";

interface PhotoPreviewProps {
  imageUrl: string | null;
  label: string;
  onCapture: () => void;
  onRemove?: () => void;
  isRequired?: boolean;
}

export function PhotoPreview({
  imageUrl,
  label,
  onCapture,
  onRemove,
  isRequired = false,
}: PhotoPreviewProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {label}
          {isRequired && <span className="text-destructive ml-1">*</span>}
        </span>
        {imageUrl && (
          <Check className="h-4 w-4 text-green-500" />
        )}
      </div>
      
      <div 
        className={`
          relative aspect-[4/3] rounded-lg border-2 border-dashed 
          ${imageUrl ? "border-primary bg-primary/5" : "border-muted-foreground/30 bg-muted/50"}
          overflow-hidden cursor-pointer transition-colors hover:border-primary/50
        `}
        onClick={onCapture}
      >
        {imageUrl ? (
          <>
            <img 
              src={imageUrl} 
              alt={label}
              className="w-full h-full object-cover"
            />
            {onRemove && (
              <Button
                variant="destructive"
                size="icon"
                className="absolute top-2 right-2 h-8 w-8"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <Camera className="h-8 w-8 mb-2" />
            <span className="text-sm">Chạm để chụp</span>
          </div>
        )}
      </div>
    </div>
  );
}
