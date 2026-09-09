export function useAuth(){return {user:{id:'fixture-user'},isOwner:!location.search.includes('readonly=1'),canEditModule:()=>!location.search.includes('readonly=1'),canAccessModule:()=>true};}
