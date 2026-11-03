import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, MapPin, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  createDealerLocationRequestId,
  DealerLocationError,
  listDealerLocations,
  parseCoordinateInput,
  setDealerLocation,
  type DealerLocationRow,
  type DealerLocationRpcClient,
  type DealerLocationSource,
} from "@/lib/dealer-location";
import { geocodeAddressPhoton, type PhotonGeocodeResult } from "@/lib/dealer-signup-api";
import { HCMC, OSM_ATTRIBUTION, OSM_TILES, loadLeaflet, type LMap, type LMarker, type LatLng } from "@/lib/leaflet-loader";

/*
 * CRM "Vị trí đại lý": staff pin the exact door of every active dealer so the
 * public signup page (/dai-ly-moi) can measure the 2 km route rule. Dealers
 * without a location are listed first; every save goes through
 * crm_set_dealer_location, which checks permission and writes the audit log.
 */

type Filter = "missing" | "pinned" | "all";

const rpcClient = supabase as unknown as DealerLocationRpcClient;
const QUERY_KEY = ["crm-dealer-locations"];

const PIN_HTML =
  '<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#d94f8a;border:3px solid #fff;box-shadow:0 2px 8px rgba(52,37,44,.35)"></div>';

const GROUP_LABEL: Record<string, string> = { banhmi_agency: "Đại lý", banhmi_point: "Bán lẻ" };

const hasLocation = (row: DealerLocationRow) => row.location_lat !== null && row.location_lng !== null;
const fmtCoord = (p: LatLng) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
const fmtDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

function messageFor(error: unknown): string {
  if (error instanceof DealerLocationError && error.code !== "unknown") {
    const messages: Record<string, string> = {
      permission_denied: "Anh/chị không có quyền ghim vị trí đại lý.",
      customer_not_found: "Không tìm thấy khách hàng.",
      customer_inactive: "Khách hàng đã ngừng hoạt động.",
      not_a_dealer: "Khách hàng không thuộc nhóm đại lý.",
      outside_vietnam: "Tọa độ nằm ngoài Việt Nam.",
      invalid_source: "Nguồn vị trí không hợp lệ.",
      invalid_coordinate: "Tọa độ không hợp lệ.",
      request_id_conflict: "Lượt lưu bị trùng. Đóng hộp thoại rồi thử lại.",
    };
    return messages[error.code] || error.message;
  }
  return "Không lưu được vị trí đại lý. Thử lại sau.";
}

export function DealerLocationPinPanel({ canView, canEdit }: { canView: boolean; canEdit: boolean }) {
  const [filter, setFilter] = useState<Filter>("missing");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DealerLocationRow | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => listDealerLocations(rpcClient),
    enabled: canView,
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const missing = rows.filter((row) => !hasLocation(row)).length;
  const visible = useMemo(() => {
    const needle = fold(search.trim());
    return rows.filter((row) => {
      if (filter === "missing" && hasLocation(row)) return false;
      if (filter === "pinned" && !hasLocation(row)) return false;
      if (!needle) return true;
      return fold(`${row.customer_name} ${row.address ?? ""}`).includes(needle);
    });
  }, [rows, filter, search]);

  if (!canView) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Bạn cần quyền CRM để xem vị trí đại lý.
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return <Card><CardContent className="pt-6"><LoadingState flat rows={4} label="Đang tải vị trí đại lý..." /></CardContent></Card>;
  }

  if (query.error) {
    return (
      <Card data-dealer-location-panel="error">
        <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>{messageFor(query.error)}</p>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>Tải lại</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chips: Array<{ id: Filter; label: string; count: number }> = [
    { id: "missing", label: "Chưa ghim", count: missing },
    { id: "pinned", label: "Đã ghim", count: rows.length - missing },
    { id: "all", label: "Tất cả", count: rows.length },
  ];

  return (
    <Card data-dealer-location-panel="v1">
      <CardHeader className="space-y-1">
        <CardTitle className="text-lg">Vị trí đại lý</CardTitle>
        <CardDescription>
          {missing > 0
            ? `Còn ${missing}/${rows.length} đại lý chưa ghim. Hồ sơ đăng ký mới gần các đại lý này sẽ phải chuyển BMQ xét tay.`
            : `Đủ vị trí cho ${rows.length} đại lý. Trang đăng ký đại lý mới tự đo được 2 km.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Lọc đại lý">
            {chips.map((chip) => (
              <Button
                key={chip.id}
                type="button"
                size="sm"
                role="tab"
                aria-selected={filter === chip.id}
                variant={filter === chip.id ? "default" : "outline"}
                onClick={() => setFilter(chip.id)}
                data-dealer-location-filter={chip.id}
              >
                {chip.label} · {chip.count}
              </Button>
            ))}
          </div>
          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tìm tên hoặc địa chỉ"
              className="pl-9"
              aria-label="Tìm đại lý"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {filter === "missing" && !search ? "Mọi đại lý đã có vị trí." : "Không có đại lý phù hợp."}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" data-dealer-location-list>
            {visible.map((row) => (
              <li key={row.id} className="flex items-center gap-3 p-3" data-dealer-location-row={row.id}>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{row.customer_name}</span>
                    <Badge variant="outline" className="font-normal">{GROUP_LABEL[row.customer_group ?? ""] ?? "Khác"}</Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{row.address || "Chưa có địa chỉ trong CRM"}</p>
                  <p className={`text-xs ${hasLocation(row) ? "text-emerald-700" : "text-amber-700"}`}>
                    {hasLocation(row) ? `Đã ghim ${fmtDate(row.location_verified_at)}` : "Chưa ghim"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={hasLocation(row) ? "outline" : "default"}
                  className="shrink-0"
                  onClick={() => setEditing(row)}
                  data-dealer-location-open={row.id}
                >
                  <MapPin className="mr-1 h-4 w-4" />
                  {canEdit ? (hasLocation(row) ? "Sửa" : "Ghim") : "Xem"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <DealerPinDialog dealer={editing} canEdit={canEdit} onClose={() => setEditing(null)} />
    </Card>
  );
}

function DealerPinDialog({ dealer, canEdit, onClose }: { dealer: DealerLocationRow | null; canEdit: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LMap | null>(null);
  const markerRef = useRef<LMarker | null>(null);
  const requestIdRef = useRef(createDealerLocationRequestId());

  const [mapState, setMapState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [point, setPoint] = useState<LatLng | null>(null);
  const [source, setSource] = useState<DealerLocationSource>("manual_pin");
  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState<PhotonGeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState("");
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const open = dealer !== null;
  const saved: LatLng | null = dealer && hasLocation(dealer)
    ? { lat: dealer.location_lat as number, lng: dealer.location_lng as number }
    : null;

  const movePin = useCallback((next: LatLng, nextSource: DealerLocationSource, zoom?: number) => {
    setPoint(next);
    setSource(nextSource);
    requestIdRef.current = createDealerLocationRequestId();
    markerRef.current?.setLatLng([next.lat, next.lng]);
    if (zoom) mapRef.current?.setView([next.lat, next.lng], zoom);
    else mapRef.current?.panTo([next.lat, next.lng]);
  }, []);

  const runSearch = useCallback(async (text: string, autoPick: boolean) => {
    if (text.trim().length < 4) return;
    setSearching(true);
    setSearchNote("");
    const results = await geocodeAddressPhoton(text.trim());
    setSearching(false);
    setSuggestions(results);
    if (results.length === 0) {
      setSearchNote("Bản đồ không tìm thấy địa chỉ này. Kéo ghim hoặc dán tọa độ.");
      return;
    }
    if (autoPick) mapRef.current?.setView([results[0].lat, results[0].lng], 17);
  }, []);

  // Reset the dialog state for each dealer.
  useEffect(() => {
    if (!dealer) return;
    setPoint(saved);
    setSource("manual_pin");
    setAddress(dealer.address ?? "");
    setSuggestions([]);
    setSearchNote("");
    setPaste("");
    setPasteError("");
    setConfirmClear(false);
    requestIdRef.current = createDealerLocationRequestId();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealer?.id]);

  // Mount the map once the dialog content is in the DOM.
  useEffect(() => {
    if (!dealer) return;
    let cancelled = false;
    let created: LMap | null = null;
    setMapState("loading");
    const timer = window.setTimeout(() => {
      loadLeaflet()
        .then((L) => {
          if (cancelled || !mapEl.current) return;
          const start = saved ?? HCMC;
          const map = L.map(mapEl.current, { zoomControl: true }).setView([start.lat, start.lng], saved ? 17 : 12);
          L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
          const icon = L.divIcon({ className: "", html: PIN_HTML, iconSize: [26, 26], iconAnchor: [4, 30] });
          const marker = L.marker([start.lat, start.lng], { draggable: canEdit, icon, keyboard: false }).addTo(map);
          if (canEdit) {
            marker.on("dragend", () => {
              const p = marker.getLatLng();
              movePin({ lat: p.lat, lng: p.lng }, "manual_pin");
            });
            map.on("click", (ev) => movePin({ lat: ev.latlng.lat, lng: ev.latlng.lng }, "manual_pin"));
          }
          created = map;
          mapRef.current = map;
          markerRef.current = marker;
          window.setTimeout(() => map.invalidateSize(), 120);
          setMapState("ready");
          if (!saved && dealer.address && canEdit) void runSearch(dealer.address, true);
        })
        .catch(() => !cancelled && setMapState("unavailable"));
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      created?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealer?.id, canEdit]);

  const save = useMutation({
    mutationFn: (clear: boolean) =>
      setDealerLocation(
        clear
          ? { customerId: dealer!.id, lat: null, lng: null, source: null, clear: true, requestId: requestIdRef.current }
          : { customerId: dealer!.id, lat: point!.lat, lng: point!.lng, source, requestId: requestIdRef.current },
        rpcClient,
      ),
    onSuccess: async (_result, clear) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: clear ? "Đã xóa vị trí" : "Đã lưu vị trí", description: dealer?.customer_name });
      onClose();
    },
    onError: (error) => {
      toast({ title: "Không lưu được", description: messageFor(error), variant: "destructive" });
    },
  });

  const usePaste = () => {
    const parsed = parseCoordinateInput(paste);
    if (!parsed) {
      setPasteError("Không đọc được tọa độ. Dán dạng 10.7769, 106.7009 hoặc link Google Maps có tọa độ.");
      return;
    }
    setPasteError("");
    movePin({ lat: parsed.lat, lng: parsed.lng }, parsed.source, 17);
  };

  const unchanged = !!(point && saved && Math.abs(point.lat - saved.lat) < 1e-7 && Math.abs(point.lng - saved.lng) < 1e-7);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto" data-dealer-location-dialog>
        <DialogHeader>
          <DialogTitle>{dealer?.customer_name}</DialogTitle>
          <DialogDescription>
            {canEdit
              ? "Kéo ghim tới đúng cửa điểm bán, hoặc chạm vào bản đồ. Cũng có thể dán tọa độ hay link Google Maps."
              : "Bạn chỉ có quyền xem vị trí."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {canEdit && (
            <div className="space-y-2">
              <Label htmlFor="dealer-pin-address">Tìm theo địa chỉ</Label>
              <div className="flex gap-2">
                <Input
                  id="dealer-pin-address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void runSearch(address, true);
                    }
                  }}
                  placeholder="Số nhà, tên đường, phường"
                />
                <Button type="button" variant="outline" onClick={() => void runSearch(address, true)} disabled={searching} className="shrink-0">
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Tìm"}
                </Button>
              </div>
              {searchNote && <p className="text-sm text-amber-700">{searchNote}</p>}
              {suggestions.length > 0 && (
                <ul className="divide-y rounded-md border text-sm" aria-label="Kết quả tìm địa chỉ">
                  {suggestions.map((item, index) => (
                    <li key={`${item.lat},${item.lng},${index}`}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-muted"
                        onClick={() => {
                          movePin({ lat: item.lat, lng: item.lng }, "manual_pin", 18);
                          setSuggestions([]);
                        }}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Bản đồ miễn phí thường thiếu số nhà: kết quả chỉ đưa tới đúng đường, hãy kéo ghim tới đúng cửa.</p>
            </div>
          )}

          <div className="relative h-[46vh] min-h-[260px] overflow-hidden rounded-lg border bg-muted md:h-[360px]">
            <div ref={mapEl} className="absolute inset-0" data-dealer-location-map />
            {mapState === "loading" && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang tải bản đồ...
              </div>
            )}
            {mapState === "unavailable" && (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Không tải được bản đồ. Vẫn có thể dán tọa độ hoặc link Google Maps bên dưới.
              </div>
            )}
          </div>

          <p className="text-sm" data-dealer-location-point>
            {point ? <>Vị trí đang chọn: <span className="font-mono">{fmtCoord(point)}</span></> : "Chưa chọn vị trí."}
          </p>

          {canEdit && (
            <div className="space-y-2">
              <Label htmlFor="dealer-pin-paste">Dán tọa độ hoặc link Google Maps</Label>
              <div className="flex gap-2">
                <Input
                  id="dealer-pin-paste"
                  value={paste}
                  onChange={(event) => setPaste(event.target.value)}
                  placeholder="10.7769, 106.7009"
                  inputMode="url"
                />
                <Button type="button" variant="outline" onClick={usePaste} disabled={!paste.trim()} className="shrink-0">Dùng</Button>
              </div>
              {pasteError && <p className="text-sm text-destructive">{pasteError}</p>}
            </div>
          )}

          {confirmClear && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              Xóa vị trí của đại lý này? Hồ sơ đăng ký mới gần đây sẽ phải chuyển BMQ xét tay cho tới khi ghim lại.
            </div>
          )}
        </div>

        {canEdit && (
          <DialogFooter className="gap-2 sm:justify-between">
            {saved ? (
              confirmClear ? (
                <div className="flex gap-2">
                  <Button type="button" variant="destructive" onClick={() => save.mutate(true)} disabled={save.isPending}>Xóa vị trí</Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmClear(false)} disabled={save.isPending}>Giữ lại</Button>
                </div>
              ) : (
                <Button type="button" variant="ghost" className="text-destructive" onClick={() => setConfirmClear(true)} disabled={save.isPending}>Xóa vị trí</Button>
              )
            ) : <span />}
            <Button
              type="button"
              onClick={() => save.mutate(false)}
              disabled={!point || unchanged || save.isPending || confirmClear}
              data-dealer-location-save
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Lưu vị trí
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
