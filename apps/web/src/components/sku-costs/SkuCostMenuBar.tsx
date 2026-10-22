import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import "@/styles/bmq-sku-costs.css";

const skuCostMenuItems = [
  { to: "/sku-costs/dashboard", label: "Tổng quan" },
  { to: "/sku-costs/analysis", label: "Xu hướng" },
  { to: "/sku-costs/management", label: "Quản trị SKU" },
];

/** One header for the three giá vốn pages: title, one line of context, actions, then the only tab row. */
export function SkuCostHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="gv-head">
      <div className="gv-head-row">
        <div className="gv-title">
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="gv-actions">{actions}</div> : null}
      </div>
      <nav className="gv-tabs" aria-label="Giá vốn">
        {skuCostMenuItems.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => cn("gv-tab", isActive && "is-on")}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
