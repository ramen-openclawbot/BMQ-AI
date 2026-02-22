declare const __APP_SEMVER__: string;

export function useAppVersion() {
  return {
    version: __APP_SEMVER__ || "v0.0.0",
    isLoading: false,
  };
}
