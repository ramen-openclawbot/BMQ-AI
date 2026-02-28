import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const sections = [
  {
    title: "Doanh thu Bánh mì",
    items: ["Doanh thu điểm bán", "Doanh thu đại lý", "Doanh thu bán Online (GrabFood, ShopeeFood, Be, Facebook)"],
  },
  {
    title: "Doanh thu Bánh ngọt",
    items: ["Kingfoodmart", "Quán cafe"],
  },
];

export default function FinanceRevenueControl() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">Kiểm soát doanh thu</h1>
        <p className="text-muted-foreground">Cấu trúc doanh thu theo nhóm/kênh đã tách riêng khỏi module quản lý chi phí.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue Control</CardTitle>
          <CardDescription>Phase 2 hoàn tất: tách module riêng. Phase 3 sẽ bổ sung form nhập liệu, KPI và workflow vận hành.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sections.map((section) => (
            <div key={section.title} className="space-y-2">
              <div className="font-semibold">{section.title}</div>
              <div className="flex flex-wrap gap-2">
                {section.items.map((item) => (
                  <Badge key={item} variant="secondary">{item}</Badge>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
