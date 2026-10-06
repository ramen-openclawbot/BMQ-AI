const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

/** Every typed word must appear in the code or name, ignoring case and diacritics. */
export const materialMatchesSearch = (haystack: string, search: string) => {
  const words = fold(search).split(/\s+/).filter(Boolean);
  const text = fold(haystack);
  return words.every((word) => text.includes(word));
};
