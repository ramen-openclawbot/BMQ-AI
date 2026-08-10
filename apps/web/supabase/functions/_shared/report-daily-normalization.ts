export type NormalizedReportChannelRow = {
  channel_code: string;
  quantity: number;
};

export class ReportChannelValidationError extends Error {
  constructor(public readonly code: "duplicate_report_channel" | "unknown_report_channel") {
    super(code);
    this.name = "ReportChannelValidationError";
  }
}

export const sumValidatedChannelQuantities = (
  channelRows: NormalizedReportChannelRow[],
  allowedChannelCodes: ReadonlySet<string>,
) => {
  const seen = new Set<string>();
  let total = 0;

  for (const row of channelRows) {
    if (!allowedChannelCodes.has(row.channel_code)) {
      throw new ReportChannelValidationError("unknown_report_channel");
    }
    if (seen.has(row.channel_code)) {
      throw new ReportChannelValidationError("duplicate_report_channel");
    }
    seen.add(row.channel_code);
    total += row.quantity;
  }

  return total;
};
