import { authenticateOwner } from "../_shared/owner.ts";
import { createSourcesHandler } from "./handler.ts";
Deno.serve(createSourcesHandler({ enabled: () => Deno.env.get("BMQ_WAREHOUSE_ENABLED") === "true", url: () => Deno.env.get("BMQ_WAREHOUSE_URL") ?? "", authenticate: authenticateOwner }));
