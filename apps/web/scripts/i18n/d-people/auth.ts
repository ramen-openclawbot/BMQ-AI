const user={id:'owner-1',email:'owner@example.invalid'};
const profile={full_name:'Tên giữ nguyên $&'};
const session={access_token:'fixture-only'};
export const getFreshAccessToken=async()=> {if(location.search.includes('auth-error'))throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');return 'fixture-only';};
export function useAuth(){return {user,profile,session,isOwner:!location.search.includes('readonly'),canEditModule:()=>!location.search.includes('readonly'),refreshProfile:async()=>{},signOut:()=>{window.dispatchEvent(new Event('fixture:signout'));}};}
