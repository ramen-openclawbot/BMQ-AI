import { useAuth as useBaseAuth } from '../fixture/auth';
export function useAuth() {
  return { ...useBaseAuth(), canEditModule: () => !location.search.includes('readonly=1') };
}
