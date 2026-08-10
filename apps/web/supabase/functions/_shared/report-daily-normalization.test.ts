import assert from "node:assert/strict";

import {
  ReportChannelValidationError,
  sumValidatedChannelQuantities,
} from "./report-daily-normalization.ts";

const allowedChannels = new Set(["khach_le", "shopeefood", "grabfood", "befood"]);

assert.equal(
  sumValidatedChannelQuantities([
    { channel_code: "khach_le", quantity: 2 },
    { channel_code: "shopeefood", quantity: 46 },
    { channel_code: "grabfood", quantity: 49 },
    { channel_code: "befood", quantity: 0 },
  ], allowedChannels),
  97,
);

assert.throws(
  () => sumValidatedChannelQuantities([
    { channel_code: "grabfood", quantity: 49 },
    { channel_code: "grabfood", quantity: 49 },
  ], allowedChannels),
  (error: unknown) => error instanceof ReportChannelValidationError && error.code === "duplicate_report_channel",
);

assert.throws(
  () => sumValidatedChannelQuantities([
    { channel_code: "grabfood", quantity: 49 },
    { channel_code: "unknown", quantity: 500 },
  ], allowedChannels),
  (error: unknown) => error instanceof ReportChannelValidationError && error.code === "unknown_report_channel",
);

console.log("PASS report daily channel normalization");
