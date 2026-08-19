import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleAttendanceCheckIn } from "./handler.ts";

serve((req) => handleAttendanceCheckIn(req));
