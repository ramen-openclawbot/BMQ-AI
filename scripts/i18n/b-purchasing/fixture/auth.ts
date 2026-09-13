// Synthetic owner/staff identities only; no authentication requests are made.
export function useAuth() {
  const owner = new URLSearchParams(location.search).get('role') !== 'staff';
  return {
    user: location.search.includes('auth-timeout') ? null : { id: '99999999-9999-4999-8999-999999999999', email: 'staff@example.invalid' }, profile: { full_name: 'Nhân viên thử nghiệm' },
    session: { access_token: 'fixture-only' }, loading: false, timedOut: location.search.includes("auth-timeout"), authzLoaded: true, isOwner: owner,
    canEditModule: () => !location.search.includes("readonly=1"),
    canAccessModule: (key: string) => new URLSearchParams(location.search).get('deny') !== key,
    signOut: () => { window.dispatchEvent(new Event('fixture:sign-out')); },
  };
}
