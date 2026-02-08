
# Phân Tích & Giải Pháp Triệt Để Vấn Đề Session Loss

## Tổng Quan Vấn Đề

App hiện tại thường xuyên bị mất session (spinner loading vô hạn, bị redirect về /auth) trên cả Chrome và Safari. Qua phân tích toàn bộ codebase, tôi đã xác định được các nguyên nhân gốc rễ và đề xuất giải pháp triệt để.

---

## Chẩn Đoán: Các Nguyên Nhân Gốc Rễ

### 1. Race Condition trong AuthContext
**Vấn đề:** `onAuthStateChange` listener và `getSession()` chạy song song, có thể gây ra tình trạng state không đồng bộ.

```text
┌─────────────────────────────────────────────────────────────────┐
│  useEffect chạy                                                 │
│  ├── setTimeout (watchdog 8s)                                   │
│  ├── onAuthStateChange (async)  ──┬──> setSession, setLoading   │
│  └── getSession() (async)       ──┘    (có thể chạy 2 lần)      │
└─────────────────────────────────────────────────────────────────┘
```

Cả hai đều gọi `setLoading(false)` nhưng không đảm bảo thứ tự. Nếu `onAuthStateChange` fire trước `getSession` resolve, có thể xảy ra:
- Session đã set nhưng loading vẫn true
- Hoặc loading false nhưng session chưa set đúng

### 2. Lazy Loading AppInner Gây Timeout
**Vấn đề:** `App.tsx` lazy load `AppInner`, nếu chunk fail load (network issue, cache stale), `Suspense` spinner hiện mãi.

```typescript
// App.tsx hiện tại
const AppInner = lazy(() => import("./AppInner"));
// Nếu import fail → spinner vô hạn
```

### 3. useVisibilityRecovery Phát Hiện Sai Session Loss
**Vấn đề:** Khi tab visible trở lại, `getSession()` có thể return `null` tạm thời (network chậm) → trigger recovery overlay không cần thiết.

### 4. QueryClient Không Clear Khi User Thay Đổi
**Vấn đề:** Khi user logout/login user khác, React Query cache không được clear → dữ liệu cũ có thể xuất hiện hoặc gây lỗi RLS.

### 5. OAuth Callback Không Xử Lý Đầy Đủ
**Vấn đề:** Trong `Auth.tsx`, sau khi `handleOAuthCallback()` thành công, navigate ngay về `/` nhưng AuthContext có thể chưa kịp update state → gây redirect loop.

---

## Giải Pháp Triệt Để

### Giải Pháp 1: Cấu Trúc Lại AuthContext (Critical)

**Nguyên tắc:** Tách biệt hoàn toàn Initial Load vs Ongoing Changes (theo best practice từ Supabase docs).

```typescript
// AuthContext.tsx - Cấu trúc mới
useEffect(() => {
  let isMounted = true;
  
  // 1. Setup listener TRƯỚC (chỉ handle ongoing changes, KHÔNG set loading)
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (event, session) => {
      if (!isMounted) return;
      // Chỉ update state, KHÔNG động vào loading
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        fetchProfile(session.user.id); // fire-and-forget
      } else {
        setProfile(null);
      }
    }
  );

  // 2. Initial load - CHỈ CÓ PHẦN NÀY control loading
  const initializeAuth = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!isMounted) return;
      
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        await fetchProfile(session.user.id); // AWAIT để đảm bảo profile loaded
      }
    } finally {
      if (isMounted) {
        setLoading(false); // Chỉ set 1 lần sau khi TẤT CẢ hoàn tất
      }
    }
  };

  initializeAuth();

  return () => {
    isMounted = false;
    subscription.unsubscribe();
  };
}, []);
```

**Lợi ích:**
- Không bao giờ có race condition giữa listener và initial load
- Loading chỉ set false SAU KHI profile đã fetch xong
- Ongoing auth changes (token refresh) không ảnh hưởng loading state

### Giải Pháp 2: Bỏ Lazy Load AppInner

```typescript
// App.tsx - Direct import
import AppInner from "./AppInner";

function App() {
  if (isRecoveryRoute()) {
    return <RecoveryScreen />;
  }
  return <AppInner />;
}
```

**Lý do:** 
- Bundle size tăng không đáng kể (AppInner chỉ là wrapper)
- Loại bỏ hoàn toàn rủi ro chunk load failure

### Giải Pháp 3: Cải Thiện useVisibilityRecovery

```typescript
// useVisibilityRecovery.ts - Thêm retry logic
const handleVisibilityChange = async () => {
  if (document.visibilityState !== 'visible') return;
  
  // Retry với backoff
  let session = null;
  for (let i = 0; i < 3; i++) {
    const { data } = await supabase.auth.getSession();
    session = data.session;
    if (session) break;
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  
  if (!session) {
    options?.onSessionLost?.();
    return;
  }
  
  queryClient.invalidateQueries({ refetchType: 'active' });
};
```

### Giải Pháp 4: Clear QueryClient Khi User Thay Đổi

```typescript
// Thêm vào AppInner.tsx hoặc AuthContext
function useClearCacheOnUserChange() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUserId = useRef<string | null>(null);

  useEffect(() => {
    if (user?.id !== prevUserId.current) {
      if (prevUserId.current !== null) {
        // User thay đổi (không phải lần đầu load)
        queryClient.clear();
      }
      prevUserId.current = user?.id ?? null;
    }
  }, [user?.id, queryClient]);
}
```

### Giải Pháp 5: Cải Thiện OAuth Callback Flow

```typescript
// Auth.tsx - Đợi AuthContext sync xong trước khi navigate
useEffect(() => {
  async function processCallback() {
    const result = await handleOAuthCallback();
    
    if (result.handled && !result.error) {
      // Đợi một chút để AuthContext nhận được session
      await new Promise(r => setTimeout(r, 200));
      navigate("/", { replace: true });
      return;
    }
    // ...
  }
  processCallback();
}, [navigate]);
```

---

## Tổng Kết Các File Cần Sửa

| File | Thay Đổi | Độ Quan Trọng |
|------|----------|---------------|
| `src/contexts/AuthContext.tsx` | Cấu trúc lại theo pattern "Initial vs Ongoing" | Critical |
| `src/App.tsx` | Bỏ lazy load AppInner | High |
| `src/AppInner.tsx` | Thêm hook clear cache khi user thay đổi | Medium |
| `src/hooks/useVisibilityRecovery.ts` | Thêm retry logic | Medium |
| `src/pages/Auth.tsx` | Cải thiện OAuth callback timing | Low |

---

## Kết Quả Mong Đợi

1. **Không còn spinner vô hạn** khi mở app trực tiếp từ URL
2. **Không còn session loss ngẫu nhiên** khi chuyển tab
3. **Dữ liệu đúng user** khi login/logout nhiều tài khoản
4. **Recovery UI hoạt động đúng** chỉ khi session thực sự mất

---

## Kế Hoạch Triển Khai Đề Xuất

**Phase 1 (Quan trọng nhất):**
- Sửa AuthContext theo pattern mới
- Bỏ lazy load AppInner

**Phase 2:**
- Thêm hook clear cache
- Cải thiện useVisibilityRecovery

**Phase 3:**
- Tinh chỉnh OAuth callback
- Test end-to-end trên Safari và Chrome
