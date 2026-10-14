// KFM minimum order: the sum of all KFM POs delivered on one day, counted in pieces (cái).
export const KFM_DAILY_MOQ_PIECES = 1500;

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

// Pieces per ordered unit: BÁNH CUA PHÔ MAI is a box of 3; CROFFLE/CROISSANT 160G are boxes of 4.
export const kfmPiecesPerUnit = (productName: string) => {
  const name = fold(productName || "");
  if (name.includes("cua pho mai")) return 3;
  if ((name.includes("croffle") || name.includes("croissant")) && name.includes("160g")) return 4;
  return 1;
};

export const kfmMoqPieces = (items: Array<{ product_name: string; qty: number }>) =>
  items.reduce((sum, item) => sum + Number(item.qty || 0) * kfmPiecesPerUnit(item.product_name), 0);
