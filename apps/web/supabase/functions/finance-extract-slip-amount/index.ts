import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { imageBase64, mimeType, slipType } = await req.json();
    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "No image provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY missing" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const system = `You extract transfer amount from Vietnamese bank slips.\nReturn only JSON via tool with fields:\n- amount: number (VND, no separators)\n- transfer_date: string | null (YYYY-MM-DD if found)\n- reference: string | null\n- confidence: number (0..1)\n- notes: string | null\n\nRules:\n- Amount must be final transfer amount, not account number.\n- If uncertain, still return best guess and lower confidence.`;

    const userText = `Slip type: ${slipType || "unknown"}. Extract transfer amount.`;

    const ai = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_slip",
              description: "Extract amount and key metadata from bank slip",
              parameters: {
                type: "object",
                properties: {
                  amount: { type: "number" },
                  transfer_date: { type: ["string", "null"] },
                  reference: { type: ["string", "null"] },
                  confidence: { type: "number" },
                  notes: { type: ["string", "null"] },
                },
                required: ["amount", "confidence"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_slip" } },
      }),
    });

    const raw = await ai.json();
    const args = raw?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    let data: any = null;
    try {
      data = args ? JSON.parse(args) : null;
    } catch {
      data = null;
    }

    if (!data || typeof data.amount !== "number") {
      return new Response(JSON.stringify({ error: "Unable to extract amount", raw }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
