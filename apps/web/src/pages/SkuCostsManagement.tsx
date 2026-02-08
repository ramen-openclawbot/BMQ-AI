import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NavLink } from "react-router-dom";

const tiles = [
  { title: "Sản phẩm", desc: "Quản lý sản phẩm, SKU, giá bán", to: "/sku-costs/products" },
  { title: "Nguyên liệu", desc: "Quản lý tồn kho, đơn vị, giá/đv", to: "/sku-costs/ingredients" },
  { title: "Nhân sự", desc: "Quản lý nhân sự, lương, vai trò", to: "/sku-costs/employees" },
  { title: "Chi phí chung", desc: "Quản lý chi phí theo nhóm/tháng", to: "/sku-costs/overhead" },
];

export default function SkuCostsManagement() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tiles.map((t) => (
          <Card key={t.to}>
            <CardHeader>
              <CardTitle>{t.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t.desc}</p>
              <Button asChild variant="outline">
                <NavLink to={t.to}>Mở</NavLink>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
