export const SUPABASE_PAGE_SIZE = 1_000;

type PageResult<T> = {
  data: T[] | null;
  error: unknown;
};

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw error;

    const page = data || [];
    rows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) return rows;
  }
}
