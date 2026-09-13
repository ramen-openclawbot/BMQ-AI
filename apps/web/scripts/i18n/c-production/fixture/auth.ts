export function useAuth() {
 const p=new URLSearchParams(location.search);
 return {user:{id:'fixture-user',email:'fixture@example.invalid'},profile:{full_name:'Nhân viên giữ nguyên'},session:{access_token:'fixture-only'},isOwner:true,canEditModule:()=>p.get('readonly')!=='1',canAccessModule:()=>p.get('deny')!=='1'};
}
