export function useAuth() {
 const params=new URLSearchParams(location.search);
 return {user:{id:'synthetic-staff'},canAccessModule:()=>params.get('fixture')!=='denied',canEditModule:()=>params.get('fixture')!=='readonly'};
}
