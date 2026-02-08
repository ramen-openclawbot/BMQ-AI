import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, ExternalLink } from "lucide-react";

interface ImagePreviewDialogProps {
  imageUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
}

export function ImagePreviewDialog({
  imageUrl,
  open,
  onOpenChange,
  title = "Xem ảnh",
}: ImagePreviewDialogProps) {
  if (!imageUrl) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 border-0 bg-black/95">
        {/* Custom close button */}
        <div className="absolute top-2 right-2 z-50 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-3 bg-white/10 hover:bg-white/20 text-white border-0"
            onClick={() => window.open(imageUrl, "_blank")}
          >
            <ExternalLink className="h-4 w-4 mr-1" />
            Mở tab mới
          </Button>
          <Button
            variant="secondary"
            size="icon"
            className="h-8 w-8 bg-white/10 hover:bg-white/20 text-white border-0"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Đóng</span>
          </Button>
        </div>

        {/* Title */}
        {title && (
          <div className="absolute top-2 left-4 z-50">
            <span className="text-white/80 text-sm font-medium">{title}</span>
          </div>
        )}

        {/* Image container */}
        <div 
          className="w-full h-full flex items-center justify-center p-4 min-h-[50vh]"
          onClick={() => onOpenChange(false)}
        >
          <img
            src={imageUrl}
            alt={title}
            className="max-w-full max-h-[85vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
