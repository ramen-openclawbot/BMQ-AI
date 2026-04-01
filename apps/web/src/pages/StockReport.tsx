import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  BarChart4,
  Package,
  ArrowUpCircle,
  ArrowDownCircle,
  Loader2,
  Filter,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { vi } from "date-fns/locale";

interface InventoryItem {
  id: string;
  name: string;
  sku_id?: string;
  quantity: number;
  unit: string;
  min_stock?: number;
  sku_type?: "raw_material" | "finished_good";
}

interface ProductSku {
  id: string;
  name: string;
  sku_code: string;
  sku_type: "raw_material" | "finished_good";
  unit: string;
}

interface InventoryMovement {
  id: string;
  date: string;
  movement_type:
    | "goods_receipt_in"
    | "production_consume"
    | "production_output"
    | "dispatch_out"
    | "adjustment";
  product_name: string;
  sku_code?: string;
  quantity: number;
  unit: string;
  reference_no?: string;
  notes?: string;
}

interface ReconciliationRow {
  product_name: string;
  opening_balance: number;
  inbound: number;
  outbound: number;
  expected_closing: number;
  actual_closing: number;
  discrepancy: number;
  unit: string;
}

const MOVEMENT_TYPE_LABELS: Record<string, { label: string; color: string }> =
  {
    goods_receipt_in: { label: "Nhập NVL", color: "bg-green-100 text-green-800" },
    production_consume: {
      label: "Tiêu hao SX",
      color: "bg-amber-100 text-amber-800",
    },
    production_output: { label: "Nhập TP", color: "bg-blue-100 text-blue-800" },
    dispatch_out: { label: "Xuất kho", color: "bg-red-100 text-red-800" },
    adjustment: { label: "Điều chỉnh", color: "bg-gray-100 text-gray-800" },
  };

const SKU_TYPE_LABELS: Record<string, string> = {
  raw_material: "NVL",
  finished_good: "TP",
};

const SKU_TYPE_COLORS: Record<string, string> = {
  raw_material: "bg-purple-100 text-purple-800",
  finished_good: "bg-orange-100 text-orange-800",
};

export default function StockReport() {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  const [dateFrom, setDateFrom] = useState<string>(
    format(monthStart, "yyyy-MM-dd")
  );
  const [dateTo, setDateTo] = useState<string>(format(monthEnd, "yyyy-MM-dd"));
  const [skuTypeFilter, setSkuTypeFilter] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState<string>("");

  // Fetch current inventory items
  const { data: inventoryItems = [], isLoading: loadingItems } = useQuery({
    queryKey: ["inventory_items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("id,name,category,quantity,unit,min_stock,supplier_id,updated_at")
        .limit(500);
      if (error) throw error;
      return (data || []) as InventoryItem[];
    },
  });

  // Fetch product SKUs
  const { data: productSkus = [] } = useQuery({
    queryKey: ["product_skus"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("product_skus")
        .select("id,sku_code,product_name,category,unit,unit_price")
        .limit(500);
      if (error) throw error;
      return (data || []) as ProductSku[];
    },
  });

  // Fetch inventory movements in date range
  const { data: movements = [], isLoading: loadingMovements } = useQuery({
    queryKey: ["inventory_movements", dateFrom, dateTo],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("inventory_movements")
        .select("id,item_id,sku_id,type,quantity,date,reference_type,reference_id,notes,created_at")
        .gte("date", dateFrom)
        .lte("date", dateTo)
        .order("date", { ascending: false })
        .limit(1000);
      if (error) throw error;
      return (data || []) as InventoryMovement[];
    },
  });

  // Filter inventory items
  const filteredInventory = useMemo(() => {
    return inventoryItems.filter((item) => {
      if (
        skuTypeFilter !== "all" &&
        item.sku_type !== skuTypeFilter
      ) {
        return false;
      }
      if (
        searchTerm &&
        !item.name.toLowerCase().includes(searchTerm.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [inventoryItems, skuTypeFilter, searchTerm]);

  // Calculate summary metrics
  const summaryMetrics = useMemo(() => {
    const inbound = movements
      .filter((m) =>
        ["goods_receipt_in", "production_output"].includes(m.movement_type)
      )
      .reduce((sum, m) => sum + m.quantity, 0);

    const outbound = Math.abs(
      movements
        .filter((m) =>
          ["production_consume", "dispatch_out"].includes(m.movement_type)
        )
        .reduce((sum, m) => sum + m.quantity, 0)
    );

    const rawMaterialStock = inventoryItems
      .filter((item) => item.sku_type === "raw_material")
      .reduce((sum, item) => sum + item.quantity, 0);

    const finishedGoodStock = inventoryItems
      .filter((item) => item.sku_type === "finished_good")
      .reduce((sum, item) => sum + item.quantity, 0);

    return {
      inbound,
      outbound,
      rawMaterialStock,
      finishedGoodStock,
    };
  }, [movements, inventoryItems]);

  // Build reconciliation data
  const reconciliationData = useMemo(() => {
    const skuMap = new Map<string, ReconciliationRow>();

    // Group movements by product
    movements.forEach((movement) => {
      const key = movement.product_name;
      if (!skuMap.has(key)) {
        const item = inventoryItems.find((i) => i.name === movement.product_name);
        skuMap.set(key, {
          product_name: movement.product_name,
          opening_balance: item?.quantity || 0,
          inbound: 0,
          outbound: 0,
          expected_closing: item?.quantity || 0,
          actual_closing: item?.quantity || 0,
          discrepancy: 0,
          unit: movement.unit,
        });
      }

      const row = skuMap.get(key)!;
      if (["goods_receipt_in", "production_output"].includes(movement.movement_type)) {
        row.inbound += movement.quantity;
      } else if (
        ["production_consume", "dispatch_out"].includes(movement.movement_type)
      ) {
        row.outbound += Math.abs(movement.quantity);
      }
    });

    // Calculate expected vs actual
    skuMap.forEach((row) => {
      row.expected_closing = row.opening_balance + row.inbound - row.outbound;
      const actual = inventoryItems.find(
        (i) => i.name === row.product_name
      );
      row.actual_closing = actual?.quantity || 0;
      row.discrepancy = row.actual_closing - row.expected_closing;
    });

    return Array.from(skuMap.values()).sort((a, b) =>
      a.product_name.localeCompare(b.product_name)
    );
  }, [movements, inventoryItems]);

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat("vi-VN").format(num);
  };

  const isLoading = loadingItems || loadingMovements;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BarChart4 className="h-8 w-8 text-blue-600" />
            <h1 className="text-3xl font-bold text-gray-900">Báo cáo tồn kho</h1>
          </div>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Từ ngày
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Đến ngày
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Loại SKU
                </label>
                <Select value={skuTypeFilter} onValueChange={setSkuTypeFilter}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tất cả</SelectItem>
                    <SelectItem value="raw_material">Nguyên vật liệu</SelectItem>
                    <SelectItem value="finished_good">Thành phẩm</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tìm kiếm sản phẩm
                </label>
                <Input
                  placeholder="Nhập tên sản phẩm..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tổng nhập kho</CardTitle>
              <ArrowUpCircle className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-green-600">
                    {formatNumber(summaryMetrics.inbound)}
                  </div>
                  <p className="text-xs text-gray-600">
                    Trong {format(new Date(dateFrom), "MMM yyyy", { locale: vi })}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tổng xuất kho</CardTitle>
              <ArrowDownCircle className="h-4 w-4 text-red-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-red-600">
                    {formatNumber(summaryMetrics.outbound)}
                  </div>
                  <p className="text-xs text-gray-600">
                    Trong {format(new Date(dateFrom), "MMM yyyy", { locale: vi })}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tồn kho NVL</CardTitle>
              <Package className="h-4 w-4 text-purple-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-purple-600">
                    {formatNumber(summaryMetrics.rawMaterialStock)}
                  </div>
                  <p className="text-xs text-gray-600">Nguyên vật liệu</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Tồn kho TP</CardTitle>
              <Package className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-orange-600">
                    {formatNumber(summaryMetrics.finishedGoodStock)}
                  </div>
                  <p className="text-xs text-gray-600">Thành phẩm</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Section 1: Current Stock */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Tồn kho hiện tại
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : filteredInventory.length === 0 ? (
              <div className="py-8 text-center text-gray-500">
                Không có dữ liệu tồn kho
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-gray-50">
                      <TableHead className="font-semibold">Tên sản phẩm</TableHead>
                      <TableHead className="font-semibold">SKU Code</TableHead>
                      <TableHead className="font-semibold">Loại</TableHead>
                      <TableHead className="text-right font-semibold">
                        Tồn kho
                      </TableHead>
                      <TableHead className="font-semibold">Đơn vị</TableHead>
                      <TableHead className="text-right font-semibold">
                        Tồn tối thiểu
                      </TableHead>
                      <TableHead className="font-semibold">Trạng thái</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredInventory.map((item) => {
                      const sku = productSkus.find(
                        (s) =>
                          s.id === item.sku_id || s.name === item.name
                      );
                      const isLowStock =
                        item.quantity <= (item.min_stock || 0);
                      const isFinishedGood =
                        item.sku_type === "finished_good";

                      return (
                        <TableRow
                          key={item.id}
                          className={
                            isFinishedGood ? "bg-orange-50" : ""
                          }
                        >
                          <TableCell className="font-medium">
                            {item.name}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600">
                            {sku?.sku_code || "-"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={
                                SKU_TYPE_COLORS[
                                  item.sku_type || "raw_material"
                                ]
                              }
                            >
                              {
                                SKU_TYPE_LABELS[
                                  item.sku_type || "raw_material"
                                ]
                              }
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-semibold text-gray-900">
                            {formatNumber(item.quantity)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {item.unit}
                          </TableCell>
                          <TableCell className="text-right text-sm text-gray-600">
                            {item.min_stock ? formatNumber(item.min_stock) : "-"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={
                                isLowStock
                                  ? "bg-red-100 text-red-800"
                                  : "bg-green-100 text-green-800"
                              }
                            >
                              {isLowStock
                                ? "Cần nhập thêm"
                                : "Đủ hàng"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 2: Movement History */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Lịch sử nhập xuất kho
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : movements.length === 0 ? (
              <div className="py-8 text-center text-gray-500">
                Không có giao dịch trong khoảng thời gian này
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-gray-50">
                      <TableHead className="font-semibold">Ngày</TableHead>
                      <TableHead className="font-semibold">
                        Loại giao dịch
                      </TableHead>
                      <TableHead className="font-semibold">Sản phẩm</TableHead>
                      <TableHead className="text-right font-semibold">
                        Số lượng
                      </TableHead>
                      <TableHead className="font-semibold">Đơn vị</TableHead>
                      <TableHead className="font-semibold">
                        Tham chiếu
                      </TableHead>
                      <TableHead className="font-semibold">Ghi chú</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movements.map((movement) => {
                      const typeInfo =
                        MOVEMENT_TYPE_LABELS[movement.movement_type];
                      const isPositive = movement.quantity > 0;

                      return (
                        <TableRow key={movement.id}>
                          <TableCell className="text-sm">
                            {format(new Date(movement.date), "dd/MM/yyyy", {
                              locale: vi,
                            })}
                          </TableCell>
                          <TableCell>
                            <Badge className={typeInfo?.color}>
                              {typeInfo?.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-medium">
                            {movement.product_name}
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold ${
                              isPositive
                                ? "text-green-600"
                                : "text-red-600"
                            }`}
                          >
                            {isPositive ? "+" : ""}
                            {formatNumber(movement.quantity)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {movement.unit}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600">
                            {movement.reference_no || "-"}
                          </TableCell>
                          <TableCell className="text-sm text-gray-600">
                            {movement.notes || "-"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Section 3: Reconciliation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Đối soát tồn kho
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              </div>
            ) : reconciliationData.length === 0 ? (
              <div className="py-8 text-center text-gray-500">
                Không có dữ liệu đối soát
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-gray-50">
                      <TableHead className="font-semibold">Sản phẩm</TableHead>
                      <TableHead className="text-right font-semibold">
                        Tồn đầu kỳ
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        Nhập trong kỳ
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        Xuất trong kỳ
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        Tồn cuối kỳ (tính)
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        Tồn thực tế
                      </TableHead>
                      <TableHead
                        className={`text-right font-semibold`}
                      >
                        Chênh lệch
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciliationData.map((row, idx) => {
                      const hasDiscrepancy = row.discrepancy !== 0;

                      return (
                        <TableRow
                          key={idx}
                          className={
                            hasDiscrepancy ? "bg-red-50" : ""
                          }
                        >
                          <TableCell className="font-medium">
                            {row.product_name}
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {formatNumber(row.opening_balance)}
                          </TableCell>
                          <TableCell className="text-right text-sm text-green-600">
                            +{formatNumber(row.inbound)}
                          </TableCell>
                          <TableCell className="text-right text-sm text-red-600">
                            -{formatNumber(row.outbound)}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-gray-900">
                            {formatNumber(row.expected_closing)}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-gray-900">
                            {formatNumber(row.actual_closing)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-semibold ${
                              hasDiscrepancy
                                ? "text-red-600"
                                : "text-green-600"
                            }`}
                          >
                            {row.discrepancy > 0 ? "+" : ""}
                            {formatNumber(row.discrepancy)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
