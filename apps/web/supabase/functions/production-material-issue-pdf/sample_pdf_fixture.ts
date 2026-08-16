import { buildQ7MaterialIssuePdf } from "./pdf_builder.ts";

const outputPath = Deno.args[0] || "/tmp/q7-material-issue-sample.pdf";
const fontBase = new URL("../_shared/fonts/", import.meta.url);
const [regular, bold] = await Promise.all([
  Deno.readFile(new URL("NotoSans-Regular.ttf", fontBase)),
  Deno.readFile(new URL("NotoSans-Bold.ttf", fontBase)),
]);

const pdfBytes = await buildQ7MaterialIssuePdf(
  {
    id: "11111111-1111-4111-8111-111111111111",
    issue_id: "11111111-1111-4111-8111-111111111111",
    issue_number: "PXK-NVL-Q7-20260816-001",
    issue_date: "2026-08-16",
    revision: 1,
    immutable_token: "22222222-2222-4222-8222-222222222222",
    source_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    production_order: { production_number: "SX-20260816-001" },
  },
  [
    { ingredient_name: "Bột mì số 13", required_qty: 12.5, unit: "kg" },
    { ingredient_name: "Pâté gan heo", required_qty: 3.25, unit: "kg" },
    { ingredient_name: "Đồ chua cà rốt", required_qty: 4.75, unit: "kg" },
    { ingredient_name: "Sốt bơ trứng", required_qty: 2.125, unit: "kg" },
  ],
  { regular, bold },
);

await Deno.writeFile(outputPath, pdfBytes);
console.error(`sample_pdf=${outputPath}`);
