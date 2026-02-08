import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Package,
  ArrowRight,
  Loader2 
} from "lucide-react";

interface MatchItem {
  deliveryName: string;
  deliveryQty: number;
  deliveryUnit: string;
  matchedName?: string;
  matchedQty?: number;
  matchedUnit?: string;
  status: "match" | "mismatch" | "extra" | "missing";
}

interface MatchingResultProps {
  isLoading?: boolean;
  isMatched: boolean;
  supplierName?: string;
  matchedPRNumber?: string;
  matchedPRTitle?: string;
  matchScore?: number;
  items: MatchItem[];
  onConfirm?: () => void;
  onCancel?: () => void;
  isConfirming?: boolean;
}

export function MatchingResult({
  isLoading = false,
  isMatched,
  supplierName,
  matchedPRNumber,
  matchedPRTitle,
  matchScore,
  items,
  onConfirm,
  onCancel,
  isConfirming = false,
}: MatchingResultProps) {
  if (isLoading) {
    return (
      <Card className="border-2">
        <CardContent className="py-12">
          <div className="flex flex-col items-center justify-center text-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
            <p className="text-lg font-medium">Đang xử lý...</p>
            <p className="text-sm text-muted-foreground mt-1">
              Đang quét và đối chiếu thông tin
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const statusIcon = isMatched ? (
    <CheckCircle className="h-6 w-6 text-green-500" />
  ) : (
    <XCircle className="h-6 w-6 text-destructive" />
  );

  const statusColor = isMatched ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200";

  return (
    <Card className={`border-2 ${statusColor}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          {statusIcon}
          <div className="flex-1">
            <CardTitle className="text-lg">
              {isMatched ? "Khớp thành công!" : "Không khớp"}
            </CardTitle>
            {supplierName && (
              <p className="text-sm text-muted-foreground mt-0.5">
                NCC: {supplierName}
              </p>
            )}
          </div>
          {matchScore !== undefined && (
            <Badge variant={isMatched ? "default" : "destructive"}>
              {Math.round(matchScore * 100)}%
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isMatched && matchedPRNumber && (
          <div className="bg-primary/10 rounded-lg p-3">
            <p className="text-sm font-medium text-primary">
              Đề nghị chi: {matchedPRNumber}
            </p>
            {matchedPRTitle && (
              <p className="text-sm text-muted-foreground mt-0.5">
                {matchedPRTitle}
              </p>
            )}
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Package className="h-4 w-4" />
            Chi tiết sản phẩm
          </h4>
          
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {items.map((item, index) => (
              <div 
                key={index}
                className={`
                  flex items-center gap-2 p-2 rounded-lg text-sm
                  ${item.status === "match" ? "bg-green-50" : 
                    item.status === "mismatch" ? "bg-yellow-50" : 
                    item.status === "extra" ? "bg-blue-50" : "bg-red-50"}
                `}
              >
                {item.status === "match" && <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />}
                {item.status === "mismatch" && <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />}
                {item.status === "extra" && <AlertTriangle className="h-4 w-4 text-blue-500 shrink-0" />}
                {item.status === "missing" && <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="truncate">{item.deliveryName}</span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      ({item.deliveryQty} {item.deliveryUnit})
                    </span>
                  </div>
                  
                  {item.status === "mismatch" && item.matchedName && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                      <ArrowRight className="h-3 w-3" />
                      <span>Duyệt chi: {item.matchedQty} {item.matchedUnit}</span>
                    </div>
                  )}
                  
                  {item.status === "extra" && (
                    <span className="text-xs text-blue-600">Thêm (không có trong duyệt chi)</span>
                  )}
                  
                  {item.status === "missing" && (
                    <span className="text-xs text-red-600">Thiếu (có trong duyệt chi)</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          {onCancel && (
            <Button
              variant="outline"
              onClick={onCancel}
              disabled={isConfirming}
              className="flex-1"
            >
              {isMatched ? "Hủy" : "Quay lại"}
            </Button>
          )}
          {isMatched && onConfirm && (
            <Button
              onClick={onConfirm}
              disabled={isConfirming}
              className="flex-1"
            >
              {isConfirming ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Đang tạo...
                </>
              ) : (
                "Tạo phiếu nhập kho"
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
