// Route ownership is explicit. Aliases inherit the owning page's batch.
export const pageBatches = {
  A: ['SkuCostsDjango', 'SkuCostsAnalysis', 'SkuCostsManagement'],
  B: ['Suppliers', 'Invoices', 'PaymentRequests', 'GoodsReceipts', 'PurchaseOrders', 'FinanceControl', 'PayablesManagement', 'RevenueManagementDashboard', 'RevenueSourceDetail', 'FinanceRevenueControl', 'RevenueDailyReview', 'NppDebtManagement', 'PointRevenueManagement'],
  C: ['Inventory', 'KitchenInventory', 'LowStock', 'MiniCrm', 'FacebookMessengerInbox', 'ProductionPlanning', 'Q7MaterialInventory', 'material-master/MaterialMasterAdmin', 'material-master/MaterialMasterSystemStatus', 'ProductionProducts', 'ProductionShifts', 'QAInspection', 'TanTaoWarehouse', 'WarehouseDispatch', 'StockReport'],
  D: ['Index', 'SkuCostsProducts', 'SkuCostsIngredients', 'SkuCostsEmployees', 'SkuCostsOverhead', 'AttendanceManagement', 'PayrollManagement', 'Settings', 'UserManagement', 'SystemManagement'],
};
export function batchForPage(file) {
  const matches = Object.entries(pageBatches).filter(([, pages]) => pages.some(page => file === `src/pages/${page}.tsx`));
  if (matches.length !== 1) throw new Error(`Staff page needs exactly one batch: ${file}`);
  return matches[0][0];
}
export const excludedPaths = ['/kho', '/auth', '/trace/:token'];
