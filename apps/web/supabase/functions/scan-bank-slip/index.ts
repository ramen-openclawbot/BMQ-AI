import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-bank-slip] Request started");

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check - simplified for prototype (no role check)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[scan-bank-slip] Missing authorization header");
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Use service role client for stable auth verification
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Validate user token using service role key (stable pattern)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.log("[scan-bank-slip] Invalid or expired token:", authError?.message);
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log("[scan-bank-slip] User authenticated:", user.id);

    // Parse request body
    const { imageBase64, mimeType } = await req.json();

    if (!imageBase64 || !mimeType) {
      return new Response(JSON.stringify({ error: 'Missing imageBase64 or mimeType' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate image size (max 10MB)
    const imageSizeBytes = (imageBase64.length * 3) / 4;
    if (imageSizeBytes > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Image too large (max 10MB)' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate MIME type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(mimeType)) {
      return new Response(JSON.stringify({ error: 'Unsupported image format' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY');
    if (!lovableApiKey) {
      console.error("[scan-bank-slip] LOVABLE_API_KEY not configured");
      return new Response(JSON.stringify({ error: 'AI API key not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // System prompt for bank slip extraction
    const systemPrompt = `You are an expert at extracting data from Vietnamese bank transfer receipts (Ủy nhiệm chi / UNC).
You will receive an image of a bank transfer slip, typically from VCB DigiBiz or similar banking apps.

Extract the following information:
1. amount: The transfer amount in VND (number only, no formatting)
2. recipient_name: The name of the recipient/beneficiary (người thụ hưởng)
3. recipient_account: The recipient's bank account number
4. recipient_bank: The recipient's bank name
5. transaction_date: The date of the transaction (format: YYYY-MM-DD)
6. transaction_id: The transaction reference number or ID
7. content: The transfer content/description (nội dung chuyển khoản)
8. sender_name: The name of the sender

Return the data in JSON format. If a field cannot be extracted, use null.`;

    // Call Lovable AI Gateway
    console.log("[scan-bank-slip] Calling AI gateway");
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBase64}`,
                },
              },
              {
                type: 'text',
                text: 'Please extract the bank transfer information from this image.',
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'extract_bank_slip_data',
              description: 'Extract structured data from a bank transfer slip image',
              parameters: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'number',
                    description: 'Transfer amount in VND (number only)',
                  },
                  recipient_name: {
                    type: 'string',
                    description: 'Name of the recipient/beneficiary',
                  },
                  recipient_account: {
                    type: 'string',
                    description: 'Recipient bank account number',
                  },
                  recipient_bank: {
                    type: 'string',
                    description: 'Recipient bank name',
                  },
                  transaction_date: {
                    type: 'string',
                    description: 'Transaction date in YYYY-MM-DD format',
                  },
                  transaction_id: {
                    type: 'string',
                    description: 'Transaction reference number',
                  },
                  content: {
                    type: 'string',
                    description: 'Transfer content/description',
                  },
                  sender_name: {
                    type: 'string',
                    description: 'Name of the sender',
                  },
                },
                required: ['amount', 'recipient_name'],
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'extract_bank_slip_data' } },
        max_tokens: 1000,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error('[scan-bank-slip] AI API error:', errorText);
      
      if (aiResponse.status === 429 || aiResponse.status === 402) {
        return new Response(JSON.stringify({ 
          error: 'AI service temporarily unavailable. Please try again later.' 
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      return new Response(JSON.stringify({ error: 'Failed to process image with AI' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse.json();
    
    // Extract the function call result
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function.name !== 'extract_bank_slip_data') {
      console.error("[scan-bank-slip] Failed to extract data from image");
      return new Response(JSON.stringify({ error: 'Failed to extract data from image' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const extractedData = JSON.parse(toolCall.function.arguments);

    console.log(`[scan-bank-slip] Completed in ${Date.now() - startTime}ms`);
    return new Response(JSON.stringify({ 
      success: true, 
      data: extractedData 
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[scan-bank-slip] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
