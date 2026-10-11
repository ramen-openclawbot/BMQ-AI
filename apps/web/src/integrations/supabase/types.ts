export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          key: string
          updated_at: string | null
          value: string
        }
        Insert: {
          key: string
          updated_at?: string | null
          value: string
        }
        Update: {
          key?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      cash_pr_idempotency: {
        Row: {
          created_at: string
          created_by: string | null
          idempotency_key: string
          payment_request_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          idempotency_key: string
          payment_request_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          idempotency_key?: string
          payment_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cash_pr_idempotency_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_categories: {
        Row: {
          code: string
          cost_group: string
          created_at: string
          id: string
          is_active: boolean
          is_revenue_related: boolean
          label: string
          parent_code: string | null
          product_line: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          code: string
          cost_group: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_revenue_related?: boolean
          label: string
          parent_code?: string | null
          product_line?: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          code?: string
          cost_group?: string
          created_at?: string
          id?: string
          is_active?: boolean
          is_revenue_related?: boolean
          label?: string
          parent_code?: string | null
          product_line?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_categories_parent_code_fkey"
            columns: ["parent_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
        ]
      }
      cost_classification_audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          after: Json
          before: Json | null
          classification_id: string | null
          created_at: string
          id: string
          reason: string | null
          source_line_id: string
          source_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          after: Json
          before?: Json | null
          classification_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          source_line_id: string
          source_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json
          before?: Json | null
          classification_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          source_line_id?: string
          source_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_classification_audit_logs_classification_id_fkey"
            columns: ["classification_id"]
            isOneToOne: false
            referencedRelation: "cost_line_classifications"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_item_alias_mappings: {
        Row: {
          active: boolean
          allocation_rule: string
          canonical_cost_item_name: string
          category_code: string
          created_at: string
          created_by: string | null
          effective_from: string | null
          effective_to: string | null
          id: string
          mapping_status: string
          matched_finished_skus: string[] | null
          product_line: string
          source_name: string
          source_name_key: string
          source_review_note: string | null
          source_sheet_url: string | null
          standard_cost_code: string
          standard_cost_code_type: string
          supplier_id: string | null
          unit_conversion_note: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          allocation_rule?: string
          canonical_cost_item_name: string
          category_code: string
          created_at?: string
          created_by?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          mapping_status?: string
          matched_finished_skus?: string[] | null
          product_line?: string
          source_name: string
          source_name_key: string
          source_review_note?: string | null
          source_sheet_url?: string | null
          standard_cost_code: string
          standard_cost_code_type: string
          supplier_id?: string | null
          unit_conversion_note?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          allocation_rule?: string
          canonical_cost_item_name?: string
          category_code?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          mapping_status?: string
          matched_finished_skus?: string[] | null
          product_line?: string
          source_name?: string
          source_name_key?: string
          source_review_note?: string | null
          source_sheet_url?: string | null
          standard_cost_code?: string
          standard_cost_code_type?: string
          supplier_id?: string | null
          unit_conversion_note?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_item_alias_mappings_category_code_fkey"
            columns: ["category_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "cost_item_alias_mappings_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_classification_rules: {
        Row: {
          active: boolean
          allocation_rule: string
          category_code: string
          confidence: number
          created_at: string
          effective_from: string | null
          effective_to: string | null
          id: string
          inventory_item_id: string | null
          keyword_pattern: string | null
          match_scope: string
          priority: number
          product_line: string
          revenue_channel: string | null
          rule_name: string
          sku_id: string | null
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          allocation_rule?: string
          category_code: string
          confidence: number
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          inventory_item_id?: string | null
          keyword_pattern?: string | null
          match_scope?: string
          priority: number
          product_line: string
          revenue_channel?: string | null
          rule_name: string
          sku_id?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          allocation_rule?: string
          category_code?: string
          confidence?: number
          created_at?: string
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          inventory_item_id?: string | null
          keyword_pattern?: string | null
          match_scope?: string
          priority?: number
          product_line?: string
          revenue_channel?: string | null
          rule_name?: string
          sku_id?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_classification_rules_category_code_fkey"
            columns: ["category_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
        ]
      }
      cost_line_classifications: {
        Row: {
          allocation_rule: string
          category_code: string
          classification_source: string
          confidence: number
          created_at: string
          id: string
          invoice_id: string | null
          note: string | null
          payment_request_id: string | null
          product_line: string
          revenue_channel: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          rule_id: string | null
          source_line_id: string
          source_type: string
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          allocation_rule?: string
          category_code: string
          classification_source: string
          confidence: number
          created_at?: string
          id?: string
          invoice_id?: string | null
          note?: string | null
          payment_request_id?: string | null
          product_line: string
          revenue_channel?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id?: string | null
          source_line_id: string
          source_type: string
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          allocation_rule?: string
          category_code?: string
          classification_source?: string
          confidence?: number
          created_at?: string
          id?: string
          invoice_id?: string | null
          note?: string | null
          payment_request_id?: string | null
          product_line?: string
          revenue_channel?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          rule_id?: string | null
          source_line_id?: string
          source_type?: string
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_line_classifications_category_code_fkey"
            columns: ["category_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
        ]
      }
      drive_file_index: {
        Row: {
          created_by: string | null
          file_id: string
          file_name: string
          file_size: number | null
          folder_date: string
          folder_type: string
          id: string
          indexed_at: string
          invoice_id: string | null
          last_seen_at: string
          mime_type: string | null
          parent_folder_id: string | null
          payment_request_id: string | null
          processed: boolean
          processed_at: string | null
          purchase_order_id: string | null
        }
        Insert: {
          created_by?: string | null
          file_id: string
          file_name: string
          file_size?: number | null
          folder_date: string
          folder_type: string
          id?: string
          indexed_at?: string
          invoice_id?: string | null
          last_seen_at?: string
          mime_type?: string | null
          parent_folder_id?: string | null
          payment_request_id?: string | null
          processed?: boolean
          processed_at?: string | null
          purchase_order_id?: string | null
        }
        Update: {
          created_by?: string | null
          file_id?: string
          file_name?: string
          file_size?: number | null
          folder_date?: string
          folder_type?: string
          id?: string
          indexed_at?: string
          invoice_id?: string | null
          last_seen_at?: string
          mime_type?: string | null
          parent_folder_id?: string | null
          payment_request_id?: string | null
          processed?: boolean
          processed_at?: string | null
          purchase_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drive_file_index_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drive_file_index_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drive_file_index_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      drive_import_logs: {
        Row: {
          created_at: string
          created_by: string | null
          error_message: string | null
          file_id: string
          file_name: string
          folder_date: string
          id: string
          import_type: string
          invoice_id: string | null
          payment_request_id: string | null
          purchase_order_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          file_id: string
          file_name: string
          folder_date: string
          id?: string
          import_type: string
          invoice_id?: string | null
          payment_request_id?: string | null
          purchase_order_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          file_id?: string
          file_name?: string
          folder_date?: string
          id?: string
          import_type?: string
          invoice_id?: string | null
          payment_request_id?: string | null
          purchase_order_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "drive_import_logs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drive_import_logs_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drive_import_logs_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      drive_sync_config: {
        Row: {
          auto_sync_interval_minutes: number | null
          created_at: string
          files_synced_count: number | null
          folder_type: string
          id: string
          last_sync_error: string | null
          last_sync_status: string | null
          last_synced_at: string | null
          sync_mode: string
          updated_at: string
        }
        Insert: {
          auto_sync_interval_minutes?: number | null
          created_at?: string
          files_synced_count?: number | null
          folder_type: string
          id?: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          sync_mode?: string
          updated_at?: string
        }
        Update: {
          auto_sync_interval_minutes?: number | null
          created_at?: string
          files_synced_count?: number | null
          folder_type?: string
          id?: string
          last_sync_error?: string | null
          last_sync_status?: string | null
          last_synced_at?: string | null
          sync_mode?: string
          updated_at?: string
        }
        Relationships: []
      }
      finance_zalo_notification_config: {
        Row: {
          created_at: string
          finance_zalo_notifications_enabled: boolean
          id: string
          worker_secret: string
        }
        Insert: {
          created_at?: string
          finance_zalo_notifications_enabled?: boolean
          id: string
          worker_secret?: string
        }
        Update: {
          created_at?: string
          finance_zalo_notifications_enabled?: boolean
          id?: string
          worker_secret?: string
        }
        Relationships: []
      }
      finance_zalo_notifications: {
        Row: {
          attempts: number
          created_at: string
          entity_id: string
          event_type: string
          group_key: string
          id: string
          last_error: string | null
          locked_at: string | null
          message_body: string
          next_attempt_at: string
          provider_message_id: string | null
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          entity_id: string
          event_type: string
          group_key?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          message_body: string
          next_attempt_at?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          entity_id?: string
          event_type?: string
          group_key?: string
          id?: string
          last_error?: string | null
          locked_at?: string | null
          message_body?: string
          next_attempt_at?: string
          provider_message_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      goods_receipt_items: {
        Row: {
          actual_quantity: number | null
          created_at: string
          expiry_date: string | null
          goods_receipt_id: string
          id: string
          inventory_item_id: string | null
          line_status: string | null
          manufacture_date: string | null
          notes: string | null
          ordered_quantity: number | null
          product_name: string
          purchase_order_item_id: string | null
          quantity: number
          sku_id: string | null
          unit: string | null
          unit_price: number | null
          variance_reason: string | null
        }
        Insert: {
          actual_quantity?: number | null
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id: string
          id?: string
          inventory_item_id?: string | null
          line_status?: string | null
          manufacture_date?: string | null
          notes?: string | null
          ordered_quantity?: number | null
          product_name: string
          purchase_order_item_id?: string | null
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number | null
          variance_reason?: string | null
        }
        Update: {
          actual_quantity?: number | null
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id?: string
          id?: string
          inventory_item_id?: string | null
          line_status?: string | null
          manufacture_date?: string | null
          notes?: string | null
          ordered_quantity?: number | null
          product_name?: string
          purchase_order_item_id?: string | null
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number | null
          variance_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "goods_receipt_items_goods_receipt_id_fkey"
            columns: ["goods_receipt_id"]
            isOneToOne: false
            referencedRelation: "goods_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipt_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipt_items_purchase_order_item_id_fkey"
            columns: ["purchase_order_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipt_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      goods_receipts: {
        Row: {
          created_at: string
          created_by: string | null
          finalized_at: string | null
          finalized_by: string | null
          id: string
          image_url: string | null
          notes: string | null
          payable_status: string
          payment_request_id: string | null
          product_photos: string[] | null
          purchase_order_id: string | null
          receipt_date: string
          receipt_number: string
          receiving_location: string | null
          status: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id: string | null
          total_quantity: number | null
          updated_at: string
          variance_summary: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          payable_status?: string
          payment_request_id?: string | null
          product_photos?: string[] | null
          purchase_order_id?: string | null
          receipt_date?: string
          receipt_number: string
          receiving_location?: string | null
          status?: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id?: string | null
          total_quantity?: number | null
          updated_at?: string
          variance_summary?: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          finalized_at?: string | null
          finalized_by?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          payable_status?: string
          payment_request_id?: string | null
          product_photos?: string[] | null
          purchase_order_id?: string | null
          receipt_date?: string
          receipt_number?: string
          receiving_location?: string | null
          status?: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id?: string | null
          total_quantity?: number | null
          updated_at?: string
          variance_summary?: Json
        }
        Relationships: [
          {
            foreignKeyName: "fk_goods_receipts_purchase_order"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goods_receipts_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_batches: {
        Row: {
          batch_number: string
          created_at: string
          expiry_date: string | null
          goods_receipt_id: string | null
          id: string
          inventory_item_id: string | null
          manufacture_date: string | null
          notes: string | null
          quantity: number
          received_date: string
          sku_id: string | null
          unit: string | null
          updated_at: string
        }
        Insert: {
          batch_number: string
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id?: string | null
          id?: string
          inventory_item_id?: string | null
          manufacture_date?: string | null
          notes?: string | null
          quantity?: number
          received_date?: string
          sku_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Update: {
          batch_number?: string
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id?: string | null
          id?: string
          inventory_item_id?: string | null
          manufacture_date?: string | null
          notes?: string | null
          quantity?: number
          received_date?: string
          sku_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_batches_goods_receipt_id_fkey"
            columns: ["goods_receipt_id"]
            isOneToOne: false
            referencedRelation: "goods_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_batches_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          id: string
          min_stock: number | null
          name: string
          quantity: number
          supplier_id: string | null
          unit: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          min_stock?: number | null
          name: string
          quantity?: number
          supplier_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          min_stock?: number | null
          name?: string
          quantity?: number
          supplier_id?: string | null
          unit?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          canonical_cost_item_name: string | null
          canonical_cost_item_source: string | null
          confirmed_standard_cost_code: string | null
          cost_allocation_rule: string | null
          cost_category_code: string | null
          cost_product_line: string | null
          cost_review_routing: string
          created_at: string
          id: string
          inventory_item_id: string | null
          invoice_id: string
          line_total: number | null
          matched_finished_skus: string[] | null
          notes: string | null
          ocr_classification_json: Json | null
          product_code: string | null
          product_name: string
          quantity: number
          raw_product_name: string | null
          standard_cost_code_type: string | null
          suggested_standard_cost_code: string | null
          unit: string | null
          unit_conversion_note: string | null
          unit_price: number
        }
        Insert: {
          canonical_cost_item_name?: string | null
          canonical_cost_item_source?: string | null
          confirmed_standard_cost_code?: string | null
          cost_allocation_rule?: string | null
          cost_category_code?: string | null
          cost_product_line?: string | null
          cost_review_routing?: string
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          invoice_id: string
          line_total?: number | null
          matched_finished_skus?: string[] | null
          notes?: string | null
          ocr_classification_json?: Json | null
          product_code?: string | null
          product_name: string
          quantity?: number
          raw_product_name?: string | null
          standard_cost_code_type?: string | null
          suggested_standard_cost_code?: string | null
          unit?: string | null
          unit_conversion_note?: string | null
          unit_price?: number
        }
        Update: {
          canonical_cost_item_name?: string | null
          canonical_cost_item_source?: string | null
          confirmed_standard_cost_code?: string | null
          cost_allocation_rule?: string | null
          cost_category_code?: string | null
          cost_product_line?: string | null
          cost_review_routing?: string
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          invoice_id?: string
          line_total?: number | null
          matched_finished_skus?: string[] | null
          notes?: string | null
          ocr_classification_json?: Json | null
          product_code?: string | null
          product_name?: string
          quantity?: number
          raw_product_name?: string | null
          standard_cost_code_type?: string | null
          suggested_standard_cost_code?: string | null
          unit?: string | null
          unit_conversion_note?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_cost_category_code_fkey"
            columns: ["cost_category_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "invoice_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          image_url: string | null
          invoice_date: string
          invoice_number: string
          notes: string | null
          payment_request_id: string | null
          payment_slip_url: string | null
          purchase_order_id: string | null
          goods_receipt_id: string | null
          subtotal: number | null
          supplier_id: string | null
          total_amount: number | null
          updated_at: string
          vat_amount: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          invoice_date?: string
          invoice_number: string
          notes?: string | null
          payment_request_id?: string | null
          payment_slip_url?: string | null
          purchase_order_id?: string | null
          goods_receipt_id?: string | null
          subtotal?: number | null
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          invoice_date?: string
          invoice_number?: string
          notes?: string | null
          payment_request_id?: string | null
          payment_slip_url?: string | null
          purchase_order_id?: string | null
          goods_receipt_id?: string | null
          subtotal?: number | null
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_goods_receipt_id_fkey"
            columns: ["goods_receipt_id"]
            isOneToOne: false
            referencedRelation: "goods_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          created_at: string
          id: string
          inventory_item_id: string | null
          order_id: string
          quantity: number
          unit_price: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          order_id: string
          quantity?: number
          unit_price?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          order_id?: string
          quantity?: number
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          order_date: string | null
          status: string
          supplier_id: string | null
          total_amount: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          order_date?: string | null
          status?: string
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_allocations: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          payment_id: string
          payment_request_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_id: string
          payment_request_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_id?: string
          payment_request_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_allocations_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_allocations_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_cash_receipts: {
        Row: {
          allocated_at: string | null
          amount: number | null
          created_at: string
          file_sha256: string
          id: string
          ocr_amount: number | null
          ocr_content: string | null
          ocr_date: string | null
          ocr_error: string | null
          ocr_payee: string | null
          ocr_reference: string | null
          payment_request_id: string
          payment_request_item_id: string | null
          status: string
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          allocated_at?: string | null
          amount?: number | null
          created_at?: string
          file_sha256: string
          id?: string
          ocr_amount?: number | null
          ocr_content?: string | null
          ocr_date?: string | null
          ocr_error?: string | null
          ocr_payee?: string | null
          ocr_reference?: string | null
          payment_request_id: string
          payment_request_item_id?: string | null
          status?: string
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          allocated_at?: string | null
          amount?: number | null
          created_at?: string
          file_sha256?: string
          id?: string
          ocr_amount?: number | null
          ocr_content?: string | null
          ocr_date?: string | null
          ocr_error?: string | null
          ocr_payee?: string | null
          ocr_reference?: string | null
          payment_request_id?: string
          payment_request_item_id?: string | null
          status?: string
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_cash_receipts_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_cash_receipts_payment_request_item_id_fkey"
            columns: ["payment_request_item_id"]
            isOneToOne: false
            referencedRelation: "payment_request_items"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_cash_settlement_idempotency: {
        Row: {
          created_at: string
          created_by: string | null
          idempotency_key: string
          payment_request_id: string
          result: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          idempotency_key: string
          payment_request_id: string
          result: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          idempotency_key?: string
          payment_request_id?: string
          result?: Json
        }
        Relationships: [
          {
            foreignKeyName: "payment_cash_settlement_idempotency_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_request_attachments: {
        Row: {
          created_at: string
          file_name: string | null
          id: string
          mime_type: string | null
          payment_request_id: string
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_name?: string | null
          id?: string
          mime_type?: string | null
          payment_request_id: string
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_name?: string | null
          id?: string
          mime_type?: string | null
          payment_request_id?: string
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_request_attachments_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_request_items: {
        Row: {
          canonical_cost_item_name: string | null
          canonical_cost_item_source: string | null
          confirmed_standard_cost_code: string | null
          cost_allocation_rule: string | null
          cost_category_code: string | null
          cost_product_line: string | null
          cost_review_routing: string
          created_at: string
          id: string
          inventory_item_id: string | null
          last_price: number | null
          line_total: number | null
          matched_finished_skus: string[] | null
          notes: string | null
          ocr_classification_json: Json | null
          payment_request_id: string
          price_change_percent: number | null
          product_code: string | null
          product_name: string
          quantity: number
          raw_product_name: string | null
          sku_id: string | null
          standard_cost_code_type: string | null
          suggested_standard_cost_code: string | null
          unit: string | null
          unit_conversion_note: string | null
          unit_price: number
        }
        Insert: {
          canonical_cost_item_name?: string | null
          canonical_cost_item_source?: string | null
          confirmed_standard_cost_code?: string | null
          cost_allocation_rule?: string | null
          cost_category_code?: string | null
          cost_product_line?: string | null
          cost_review_routing?: string
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          last_price?: number | null
          line_total?: number | null
          matched_finished_skus?: string[] | null
          notes?: string | null
          ocr_classification_json?: Json | null
          payment_request_id: string
          price_change_percent?: number | null
          product_code?: string | null
          product_name: string
          quantity?: number
          raw_product_name?: string | null
          sku_id?: string | null
          standard_cost_code_type?: string | null
          suggested_standard_cost_code?: string | null
          unit?: string | null
          unit_conversion_note?: string | null
          unit_price?: number
        }
        Update: {
          canonical_cost_item_name?: string | null
          canonical_cost_item_source?: string | null
          confirmed_standard_cost_code?: string | null
          cost_allocation_rule?: string | null
          cost_category_code?: string | null
          cost_product_line?: string | null
          cost_review_routing?: string
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          last_price?: number | null
          line_total?: number | null
          matched_finished_skus?: string[] | null
          notes?: string | null
          ocr_classification_json?: Json | null
          payment_request_id?: string
          price_change_percent?: number | null
          product_code?: string | null
          product_name?: string
          quantity?: number
          raw_product_name?: string | null
          sku_id?: string | null
          standard_cost_code_type?: string | null
          suggested_standard_cost_code?: string | null
          unit?: string | null
          unit_conversion_note?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_request_items_cost_category_code_fkey"
            columns: ["cost_category_code"]
            isOneToOne: false
            referencedRelation: "cost_categories"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "payment_request_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_request_items_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_request_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          cash_settlement_status: string | null
          cash_settled_at: string | null
          cash_settled_by: string | null
          created_at: string
          created_by: string | null
          delivery_status: Database["public"]["Enums"]["delivery_status"]
          description: string | null
          goods_receipt_id: string | null
          id: string
          image_url: string | null
          invoice_created: boolean | null
          invoice_id: string | null
          notes: string | null
          payment_method:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          paid_at: string | null
          payment_status: Database["public"]["Enums"]["payment_status"]
          payment_type: Database["public"]["Enums"]["payment_type"] | null
          purchase_order_id: string | null
          requires_receipt: boolean
          no_receipt_reason: string | null
          no_receipt_set_at: string | null
          no_receipt_set_by: string | null
          rejection_reason: string | null
          request_number: string
          status: Database["public"]["Enums"]["payment_request_status"]
          supplier_id: string | null
          title: string
          total_amount: number | null
          updated_at: string
          vat_amount: number | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          cash_settlement_status?: string | null
          cash_settled_at?: string | null
          cash_settled_by?: string | null
          created_at?: string
          created_by?: string | null
          delivery_status?: Database["public"]["Enums"]["delivery_status"]
          description?: string | null
          goods_receipt_id?: string | null
          id?: string
          image_url?: string | null
          invoice_created?: boolean | null
          invoice_id?: string | null
          notes?: string | null
          payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          paid_at?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          payment_type?: Database["public"]["Enums"]["payment_type"] | null
          purchase_order_id?: string | null
          requires_receipt?: boolean
          no_receipt_reason?: string | null
          no_receipt_set_at?: string | null
          no_receipt_set_by?: string | null
          rejection_reason?: string | null
          request_number: string
          status?: Database["public"]["Enums"]["payment_request_status"]
          supplier_id?: string | null
          title: string
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          cash_settlement_status?: string | null
          cash_settled_at?: string | null
          cash_settled_by?: string | null
          created_at?: string
          created_by?: string | null
          delivery_status?: Database["public"]["Enums"]["delivery_status"]
          description?: string | null
          goods_receipt_id?: string | null
          id?: string
          image_url?: string | null
          invoice_created?: boolean | null
          invoice_id?: string | null
          notes?: string | null
          payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          paid_at?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          payment_type?: Database["public"]["Enums"]["payment_type"] | null
          purchase_order_id?: string | null
          requires_receipt?: boolean
          no_receipt_reason?: string | null
          no_receipt_set_at?: string | null
          no_receipt_set_by?: string | null
          rejection_reason?: string | null
          request_number?: string
          status?: Database["public"]["Enums"]["payment_request_status"]
          supplier_id?: string | null
          title?: string
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_requests_goods_receipt_id_fkey"
            columns: ["goods_receipt_id"]
            isOneToOne: false
            referencedRelation: "goods_receipts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_requests_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_requests_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_requests_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_submission_idempotency: {
        Row: {
          created_at: string
          created_by: string | null
          idempotency_key: string
          result: Json
          submission_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          idempotency_key: string
          result: Json
          submission_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          idempotency_key?: string
          result?: Json
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_submission_idempotency_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "payment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_submission_items: {
        Row: {
          payment_request_id: string
          position: number
          remaining_at_submit: number
          submission_id: string
        }
        Insert: {
          payment_request_id: string
          position: number
          remaining_at_submit: number
          submission_id: string
        }
        Update: {
          payment_request_id?: string
          position?: number
          remaining_at_submit?: number
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_submission_items_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submission_items_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "payment_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_submissions: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          submission_number: string
          total_amount: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          submission_number: string
          total_amount?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          submission_number?: string
          total_amount?: number
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          payment_date: string
          payment_method:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          payment_number: string
          reference_number: string | null
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          payment_number: string
          reference_number?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          payment_date?: string
          payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          payment_number?: string
          reference_number?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_unc_evidence: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          file_sha256: string
          id: string
          manual_override: boolean
          note: string | null
          ocr_amount: number | null
          ocr_beneficiary_account: string | null
          ocr_confidence: number | null
          ocr_reference: string | null
          override_reason: string | null
          payment_id: string | null
          storage_path: string | null
          transfer_date: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          file_sha256: string
          id?: string
          manual_override?: boolean
          note?: string | null
          ocr_amount?: number | null
          ocr_beneficiary_account?: string | null
          ocr_confidence?: number | null
          ocr_reference?: string | null
          override_reason?: string | null
          payment_id?: string | null
          storage_path?: string | null
          transfer_date?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          file_sha256?: string
          id?: string
          manual_override?: boolean
          note?: string | null
          ocr_amount?: number | null
          ocr_beneficiary_account?: string | null
          ocr_confidence?: number | null
          ocr_reference?: string | null
          override_reason?: string | null
          payment_id?: string | null
          storage_path?: string | null
          transfer_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_unc_evidence_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_unc_idempotency: {
        Row: {
          created_at: string
          created_by: string | null
          idempotency_key: string
          result: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          idempotency_key: string
          result: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          idempotency_key?: string
          result?: Json
        }
        Relationships: []
      }
      payment_unc_ocr_drafts: {
        Row: {
          amount_in_words: string | null
          amount_raw: string | null
          created_at: string
          created_by: string | null
          file_sha256: string
          ocr_amount: number | null
          ocr_beneficiary_account: string | null
          ocr_beneficiary_name: string | null
          ocr_confidence: number | null
          ocr_reference: string | null
          ocr_transfer_content: string | null
          storage_path: string
          transfer_date: string | null
        }
        Insert: {
          amount_in_words?: string | null
          amount_raw?: string | null
          created_at?: string
          created_by?: string | null
          file_sha256: string
          ocr_amount?: number | null
          ocr_beneficiary_account?: string | null
          ocr_beneficiary_name?: string | null
          ocr_confidence?: number | null
          ocr_reference?: string | null
          ocr_transfer_content?: string | null
          storage_path: string
          transfer_date?: string | null
        }
        Update: {
          amount_in_words?: string | null
          amount_raw?: string | null
          created_at?: string
          created_by?: string | null
          file_sha256?: string
          ocr_amount?: number | null
          ocr_beneficiary_account?: string | null
          ocr_beneficiary_name?: string | null
          ocr_confidence?: number | null
          ocr_reference?: string | null
          ocr_transfer_content?: string | null
          storage_path?: string
          transfer_date?: string | null
        }
        Relationships: []
      }
      finance_jev_duplicate_checks: {
        Row: {
          amount_newer: number | null
          amount_older: number | null
          checked_at: string
          days_apart: number | null
          id: string
          model: string | null
          p_same: number | null
          pair_key: string
          pr_newer: string
          pr_older: string
          prompt_version: string | null
          relation: string | null
          relation_confidence: number | null
          relation_prob: number | null
          review_decision: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          state_hash: string
          status: string
          supplier_id: string | null
        }
        Insert: {
          amount_newer?: number | null
          amount_older?: number | null
          checked_at?: string
          days_apart?: number | null
          id?: string
          model?: string | null
          p_same?: number | null
          pair_key: string
          pr_newer: string
          pr_older: string
          prompt_version?: string | null
          relation?: string | null
          relation_confidence?: number | null
          relation_prob?: number | null
          review_decision?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          state_hash: string
          status: string
          supplier_id?: string | null
        }
        Update: {
          amount_newer?: number | null
          amount_older?: number | null
          checked_at?: string
          days_apart?: number | null
          id?: string
          model?: string | null
          p_same?: number | null
          pair_key?: string
          pr_newer?: string
          pr_older?: string
          prompt_version?: string | null
          relation?: string | null
          relation_confidence?: number | null
          relation_prob?: number | null
          review_decision?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          state_hash?: string
          status?: string
          supplier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_jev_duplicate_checks_pr_newer_fkey"
            columns: ["pr_newer"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_jev_duplicate_checks_pr_older_fkey"
            columns: ["pr_older"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_jev_duplicate_checks_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_reconciliation_reviews: {
        Row: {
          flag_key: string
          note: string | null
          reviewed_at: string
          reviewed_by: string | null
          status: string
        }
        Insert: {
          flag_key: string
          note?: string | null
          reviewed_at?: string
          reviewed_by?: string | null
          status: string
        }
        Update: {
          flag_key?: string
          note?: string | null
          reviewed_at?: string
          reviewed_by?: string | null
          status?: string
        }
        Relationships: []
      }
      purchase_order_overpay_allowances: {
        Row: {
          created_at: string
          created_by: string | null
          extra_amount: number
          id: string
          purchase_order_id: string
          reason: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          extra_amount: number
          id?: string
          purchase_order_id: string
          reason: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          extra_amount?: number
          id?: string
          purchase_order_id?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_overpay_allowances_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      dealer_sessions: {
        Row: {
          contact_id: string
          created_at: string
          customer_id: string
          expires_at: string
          id: string
          last_seen_at: string | null
          request_ip: string | null
          revoked_at: string | null
          revoked_reason: string | null
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          contact_id: string
          created_at?: string
          customer_id: string
          expires_at: string
          id?: string
          last_seen_at?: string | null
          request_ip?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          contact_id?: string
          created_at?: string
          customer_id?: string
          expires_at?: string
          id?: string
          last_seen_at?: string | null
          request_ip?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      mini_crm_customers: {
        Row: {
          address: string | null
          created_at: string
          customer_code: string | null
          customer_group: string | null
          customer_name: string
          id: string
          is_active: boolean
          is_npp: boolean
          order_lock_reason: string | null
          order_locked: boolean
          order_locked_at: string | null
          order_locked_by: string | null
          product_group: string | null
          supplied_by_npp_customer_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          customer_code?: string | null
          customer_group?: string | null
          customer_name: string
          id?: string
          is_active?: boolean
          is_npp?: boolean
          order_lock_reason?: string | null
          order_locked?: boolean
          order_locked_at?: string | null
          order_locked_by?: string | null
          product_group?: string | null
          supplied_by_npp_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          customer_code?: string | null
          customer_group?: string | null
          customer_name?: string
          id?: string
          is_active?: boolean
          is_npp?: boolean
          order_lock_reason?: string | null
          order_locked?: boolean
          order_locked_at?: string | null
          order_locked_by?: string | null
          product_group?: string | null
          supplied_by_npp_customer_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      product_skus: {
        Row: {
          category: string | null
          sku_type: Database["public"]["Enums"]["sku_type"]
          created_at: string
          created_by: string | null
          hide_from_dealer_portal: boolean
          id: string
          image_path: string | null
          image_updated_at: string | null
          image_url: string | null
          notes: string | null
          product_name: string
          sku_code: string
          supplier_id: string | null
          unit: string | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          sku_type?: Database["public"]["Enums"]["sku_type"]
          created_at?: string
          created_by?: string | null
          hide_from_dealer_portal?: boolean
          id?: string
          image_path?: string | null
          image_updated_at?: string | null
          image_url?: string | null
          notes?: string | null
          product_name: string
          sku_code: string
          supplier_id?: string | null
          unit?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          sku_type?: Database["public"]["Enums"]["sku_type"]
          created_at?: string
          created_by?: string | null
          hide_from_dealer_portal?: boolean
          id?: string
          image_path?: string | null
          image_updated_at?: string | null
          image_url?: string | null
          notes?: string | null
          product_name?: string
          sku_code?: string
          supplier_id?: string | null
          unit?: string | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_skus_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      purchase_order_items: {
        Row: {
          created_at: string
          id: string
          line_total: number | null
          notes: string | null
          product_name: string
          purchase_order_id: string
          quantity: number
          sku_id: string | null
          unit: string | null
          unit_price: number | null
        }
        Insert: {
          created_at?: string
          id?: string
          line_total?: number | null
          notes?: string | null
          product_name: string
          purchase_order_id: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number | null
        }
        Update: {
          created_at?: string
          id?: string
          line_total?: number | null
          notes?: string | null
          product_name?: string
          purchase_order_id?: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          created_at: string
          created_by: string | null
          expected_date: string | null
          id: string
          image_url: string | null
          notes: string | null
          order_date: string
          po_number: string
          status: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id: string | null
          total_amount: number | null
          updated_at: string
          vat_amount: number | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          order_date?: string
          po_number: string
          status?: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expected_date?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          order_date?: string
          po_number?: string
          status?: Database["public"]["Enums"]["purchase_order_status"]
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      q7_auto_purchase_decisions: {
        Row: {
          amount: number | null
          created_at: string
          decision: string
          error_message: string | null
          forecast_avg_14d: number | null
          forecast_avg_28d: number | null
          forecast_stddev_28d: number | null
          id: string
          item_id: string
          on_hand: number | null
          open_po_qty: number | null
          purchase_order_id: string | null
          reason_codes: string[]
          reorder_date: string | null
          run_id: string
          suggested_qty: number | null
          unit_price: number | null
        }
        Insert: {
          amount?: number | null
          created_at?: string
          decision: string
          error_message?: string | null
          forecast_avg_14d?: number | null
          forecast_avg_28d?: number | null
          forecast_stddev_28d?: number | null
          id?: string
          item_id: string
          on_hand?: number | null
          open_po_qty?: number | null
          purchase_order_id?: string | null
          reason_codes?: string[]
          reorder_date?: string | null
          run_id: string
          suggested_qty?: number | null
          unit_price?: number | null
        }
        Update: {
          amount?: number | null
          created_at?: string
          decision?: string
          error_message?: string | null
          forecast_avg_14d?: number | null
          forecast_avg_28d?: number | null
          forecast_stddev_28d?: number | null
          id?: string
          item_id?: string
          on_hand?: number | null
          open_po_qty?: number | null
          purchase_order_id?: string | null
          reason_codes?: string[]
          reorder_date?: string | null
          run_id?: string
          suggested_qty?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "q7_auto_purchase_decisions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "q7_auto_purchase_decisions_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "q7_auto_purchase_decisions_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "q7_auto_purchase_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      q7_auto_purchase_runs: {
        Row: {
          created_by: string | null
          finished_at: string | null
          id: string
          run_date: string
          started_at: string
          status: string
          summary: Json
        }
        Insert: {
          created_by?: string | null
          finished_at?: string | null
          id?: string
          run_date: string
          started_at?: string
          status?: string
          summary?: Json
        }
        Update: {
          created_by?: string | null
          finished_at?: string | null
          id?: string
          run_date?: string
          started_at?: string
          status?: string
          summary?: Json
        }
        Relationships: []
      }
      q7_auto_purchase_settings: {
        Row: {
          enabled: boolean
          id: number
          max_backtest_error: number
          max_daily_amount: number
          max_po_amount: number
          max_stock_count_age_days: number
          run_hour_vn: number
          system_actor_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          id?: number
          max_backtest_error?: number
          max_daily_amount?: number
          max_po_amount?: number
          max_stock_count_age_days?: number
          run_hour_vn?: number
          system_actor_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          id?: number
          max_backtest_error?: number
          max_daily_amount?: number
          max_po_amount?: number
          max_stock_count_age_days?: number
          run_hour_vn?: number
          system_actor_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      q7_purchase_item_settings: {
        Row: {
          created_at: string
          id: string
          kitchen_inventory_item_id: string
          lead_time_days: number | null
          learned_at: string | null
          learned_backtest_error: number | null
          learned_lead_time_days: number | null
          learned_pack_label: string | null
          learned_pack_size: number | null
          learned_safety_days: number | null
          learned_supplier_id: string | null
          max_order_qty: number | null
          mode: string
          order_cycle_days: number
          pack_label: string | null
          pack_size: number | null
          safety_days: number | null
          supplier_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kitchen_inventory_item_id: string
          lead_time_days?: number | null
          learned_at?: string | null
          learned_backtest_error?: number | null
          learned_lead_time_days?: number | null
          learned_pack_label?: string | null
          learned_pack_size?: number | null
          learned_safety_days?: number | null
          learned_supplier_id?: string | null
          max_order_qty?: number | null
          mode?: string
          order_cycle_days?: number
          pack_label?: string | null
          pack_size?: number | null
          safety_days?: number | null
          supplier_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kitchen_inventory_item_id?: string
          lead_time_days?: number | null
          learned_at?: string | null
          learned_backtest_error?: number | null
          learned_lead_time_days?: number | null
          learned_pack_label?: string | null
          learned_pack_size?: number | null
          learned_safety_days?: number | null
          learned_supplier_id?: string | null
          max_order_qty?: number | null
          mode?: string
          order_cycle_days?: number
          pack_label?: string | null
          pack_size?: number | null
          safety_days?: number | null
          supplier_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "q7_purchase_item_settings_kitchen_inventory_item_id_fkey"
            columns: ["kitchen_inventory_item_id"]
            isOneToOne: true
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "q7_purchase_item_settings_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_routing_suggestions: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          cost: number | null
          created_at: string
          evidence: Json | null
          id: string
          jev_answer: Json | null
          previous_exempt: boolean | null
          previous_location: string | null
          probability: number
          prompt_version: string
          proposed_location: string
          status: string
          supplier_id: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          cost?: number | null
          created_at?: string
          evidence?: Json | null
          id?: string
          jev_answer?: Json | null
          previous_exempt?: boolean | null
          previous_location?: string | null
          probability: number
          prompt_version: string
          proposed_location: string
          status?: string
          supplier_id: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          cost?: number | null
          created_at?: string
          evidence?: Json | null
          id?: string
          jev_answer?: Json | null
          previous_exempt?: boolean | null
          previous_location?: string | null
          probability?: number
          prompt_version?: string
          proposed_location?: string
          status?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_routing_suggestions_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          bank_account_name: string | null
          category: string | null
          contract_url: string | null
          created_at: string
          created_by: string | null
          default_payment_method:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          default_receiving_location: string | null
          description: string | null
          email: string | null
          id: string
          name: string
          payment_terms_days: number | null
          phone: string | null
          receiving_location_set_at: string | null
          receiving_location_source: string | null
          short_code: string | null
          stock_exempt: boolean
          updated_at: string
          vat_included_in_price: boolean | null
        }
        Insert: {
          address?: string | null
          bank_account_name?: string | null
          category?: string | null
          contract_url?: string | null
          created_at?: string
          created_by?: string | null
          default_payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          default_receiving_location?: string | null
          description?: string | null
          email?: string | null
          id?: string
          name: string
          payment_terms_days?: number | null
          phone?: string | null
          receiving_location_set_at?: string | null
          receiving_location_source?: string | null
          short_code?: string | null
          stock_exempt?: boolean
          updated_at?: string
          vat_included_in_price?: boolean | null
        }
        Update: {
          address?: string | null
          bank_account_name?: string | null
          category?: string | null
          contract_url?: string | null
          created_at?: string
          created_by?: string | null
          default_payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          default_receiving_location?: string | null
          description?: string | null
          email?: string | null
          id?: string
          name?: string
          payment_terms_days?: number | null
          phone?: string | null
          receiving_location_set_at?: string | null
          receiving_location_source?: string | null
          short_code?: string | null
          stock_exempt?: boolean
          updated_at?: string
          vat_included_in_price?: boolean | null
        }
        Relationships: []
      }
      stock_ledger_settings: {
        Row: {
          id: number
          q7_cutover_date: string | null
          tan_tao_cutover_date: string | null
          updated_at: string
        }
        Insert: {
          id?: number
          q7_cutover_date?: string | null
          tan_tao_cutover_date?: string | null
          updated_at?: string
        }
        Update: {
          id?: number
          q7_cutover_date?: string | null
          tan_tao_cutover_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      material_category_suggestions: {
        Row: {
          cost: number | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          jev_answer: Json | null
          material_id: string
          previous_category: string | null
          probability: number
          prompt_version: string
          proposed_category: string
          status: string
        }
        Insert: {
          cost?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          jev_answer?: Json | null
          material_id: string
          previous_category?: string | null
          probability: number
          prompt_version: string
          proposed_category: string
          status?: string
        }
        Update: {
          cost?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          jev_answer?: Json | null
          material_id?: string
          previous_category?: string | null
          probability?: number
          prompt_version?: string
          proposed_category?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_category_suggestions_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "sku_cogs_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_category_suggestions_proposed_category_fkey"
            columns: ["proposed_category"]
            isOneToOne: false
            referencedRelation: "stock_material_categories"
            referencedColumns: ["code"]
          },
        ]
      }
      material_alias_events: {
        Row: {
          action: string
          actor_id: string | null
          alias_id: string | null
          created_at: string
          id: string
          jev_item_id: string | null
          jev_probability: number | null
          new_factor: number | null
          new_item_id: string | null
          new_line_class: string | null
          new_sku_id: string | null
          previous_factor: number | null
          previous_item_id: string | null
          previous_line_class: string | null
          previous_sku_id: string | null
          raw_name: string | null
          raw_unit: string | null
          source_id: string | null
          source_table: string | null
          undo_of_event_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          alias_id?: string | null
          created_at?: string
          id?: string
          jev_item_id?: string | null
          jev_probability?: number | null
          new_factor?: number | null
          new_item_id?: string | null
          new_line_class?: string | null
          new_sku_id?: string | null
          previous_factor?: number | null
          previous_item_id?: string | null
          previous_line_class?: string | null
          previous_sku_id?: string | null
          raw_name?: string | null
          raw_unit?: string | null
          source_id?: string | null
          source_table?: string | null
          undo_of_event_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          alias_id?: string | null
          created_at?: string
          id?: string
          jev_item_id?: string | null
          jev_probability?: number | null
          new_factor?: number | null
          new_item_id?: string | null
          new_line_class?: string | null
          new_sku_id?: string | null
          previous_factor?: number | null
          previous_item_id?: string | null
          previous_line_class?: string | null
          previous_sku_id?: string | null
          raw_name?: string | null
          raw_unit?: string | null
          source_id?: string | null
          source_table?: string | null
          undo_of_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_alias_events_alias_id_fkey"
            columns: ["alias_id"]
            isOneToOne: false
            referencedRelation: "stock_material_aliases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_alias_events_undo_of_event_id_fkey"
            columns: ["undo_of_event_id"]
            isOneToOne: false
            referencedRelation: "material_alias_events"
            referencedColumns: ["id"]
          },
        ]
      }
      material_alias_jev_cache: {
        Row: {
          answer: Json
          candidates_hash: string
          cost: number | null
          created_at: string
          id: string
          location: string
          normalized_name: string
          prompt_version: string
          supplier_id: string | null
        }
        Insert: {
          answer: Json
          candidates_hash: string
          cost?: number | null
          created_at?: string
          id?: string
          location: string
          normalized_name: string
          prompt_version: string
          supplier_id?: string | null
        }
        Update: {
          answer?: Json
          candidates_hash?: string
          cost?: number | null
          created_at?: string
          id?: string
          location?: string
          normalized_name?: string
          prompt_version?: string
          supplier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_alias_jev_cache_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_material_categories: {
        Row: {
          code: string
          label_vi: string
          sort_order: number
        }
        Insert: {
          code: string
          label_vi: string
          sort_order?: number
        }
        Update: {
          code?: string
          label_vi?: string
          sort_order?: number
        }
        Relationships: []
      }
      stock_material_aliases: {
        Row: {
          conversion_factor: number
          created_at: string
          created_by: string | null
          id: string
          kitchen_inventory_item_id: string | null
          line_class: string
          location: string
          normalized_name: string
          supplier_id: string | null
          tan_tao_sku_id: string | null
          unit: string
          updated_at: string
          confirm_count: number
          confirmers: string[]
          status: string
          pack_label: string | null
          last_confirmed_at: string | null
          jev_item_id: string | null
          jev_probability: number | null
          jev_disagreed: boolean
          prompt_version: string | null
        }
        Insert: {
          conversion_factor?: number
          created_at?: string
          created_by?: string | null
          id?: string
          kitchen_inventory_item_id?: string | null
          line_class?: string
          location: string
          normalized_name: string
          supplier_id?: string | null
          tan_tao_sku_id?: string | null
          unit: string
          updated_at?: string
          confirm_count?: number
          confirmers?: string[]
          status?: string
          pack_label?: string | null
          last_confirmed_at?: string | null
          jev_item_id?: string | null
          jev_probability?: number | null
          jev_disagreed?: boolean
          prompt_version?: string | null
        }
        Update: {
          conversion_factor?: number
          created_at?: string
          created_by?: string | null
          id?: string
          kitchen_inventory_item_id?: string | null
          line_class?: string
          location?: string
          normalized_name?: string
          supplier_id?: string | null
          tan_tao_sku_id?: string | null
          unit?: string
          updated_at?: string
          confirm_count?: number
          confirmers?: string[]
          status?: string
          pack_label?: string | null
          last_confirmed_at?: string | null
          jev_item_id?: string | null
          jev_probability?: number | null
          jev_disagreed?: boolean
          prompt_version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_material_aliases_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_material_aliases_tan_tao_sku_id_fkey"
            columns: ["tan_tao_sku_id"]
            isOneToOne: false
            referencedRelation: "product_skus"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      salary_payout_idempotency: {
        Row: {
          created_at: string
          created_by: string | null
          idempotency_key: string
          payout_id: string
          result: Json
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          idempotency_key: string
          payout_id: string
          result: Json
        }
        Update: {
          created_at?: string
          created_by?: string | null
          idempotency_key?: string
          payout_id?: string
          result?: Json
        }
        Relationships: []
      }
      salary_payout_lines: {
        Row: {
          employee_code: string
          employee_name: string
          id: string
          matched_at: string | null
          matched_by: string | null
          net_pay: number
          note: string | null
          payout_id: string
          receipt_amount: number | null
          receipt_beneficiary: string | null
          receipt_reference: string | null
          receipt_sha256: string | null
          receipt_storage_path: string | null
        }
        Insert: {
          employee_code: string
          employee_name: string
          id?: string
          matched_at?: string | null
          matched_by?: string | null
          net_pay: number
          note?: string | null
          payout_id: string
          receipt_amount?: number | null
          receipt_beneficiary?: string | null
          receipt_reference?: string | null
          receipt_sha256?: string | null
          receipt_storage_path?: string | null
        }
        Update: {
          employee_code?: string
          employee_name?: string
          id?: string
          matched_at?: string | null
          matched_by?: string | null
          net_pay?: number
          note?: string | null
          payout_id?: string
          receipt_amount?: number | null
          receipt_beneficiary?: string | null
          receipt_reference?: string | null
          receipt_sha256?: string | null
          receipt_storage_path?: string | null
        }
        Relationships: []
      }
      salary_payout_receipts: {
        Row: {
          created_at: string
          file_sha256: string
          id: string
          ocr_amount: number | null
          ocr_beneficiary: string | null
          ocr_error: string | null
          ocr_reference: string | null
          payout_id: string
          status: string
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          file_sha256: string
          id?: string
          ocr_amount?: number | null
          ocr_beneficiary?: string | null
          ocr_error?: string | null
          ocr_reference?: string | null
          payout_id: string
          status?: string
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          file_sha256?: string
          id?: string
          ocr_amount?: number | null
          ocr_beneficiary?: string | null
          ocr_error?: string | null
          ocr_reference?: string | null
          payout_id?: string
          status?: string
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      salary_payouts: {
        Row: {
          ceo_evidence_sha256: string | null
          ceo_evidence_storage_path: string | null
          ceo_paid_at: string | null
          ceo_paid_by: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string | null
          employee_count: number
          id: string
          note: string | null
          payroll_period_id: string | null
          payout_number: string
          period_name: string
          source: string
          status: string
          total_amount: number
        }
        Insert: {
          ceo_evidence_sha256?: string | null
          ceo_evidence_storage_path?: string | null
          ceo_paid_at?: string | null
          ceo_paid_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          employee_count: number
          id?: string
          note?: string | null
          payroll_period_id: string | null
          payout_number: string
          period_name: string
          source?: string
          status?: string
          total_amount: number
        }
        Update: {
          ceo_evidence_sha256?: string | null
          ceo_evidence_storage_path?: string | null
          ceo_paid_at?: string | null
          ceo_paid_by?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string | null
          employee_count?: number
          id?: string
          note?: string | null
          payroll_period_id?: string | null
          payout_number?: string
          period_name?: string
          source?: string
          status?: string
          total_amount?: number
        }
        Relationships: []
      }
      kitchen_inventory_items: {
        Row: {
          active: boolean
          canonical_material_id: string | null
          created_at: string
          id: string
          inventory_item_id: string | null
          item_class: string | null
          item_class_source: string | null
          item_code: string
          item_type: string
          material_resolution_request_id: string | null
          material_resolution_status: string | null
          merged_at: string | null
          merged_factor: number | null
          merged_into_id: string | null
          name: string
          normalized_key: string
          product_sku_id: string | null
          source_hash: string | null
          standard_unit_cost: number
          trusted_source_batch_id: string | null
          trusted_source_row_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          canonical_material_id?: string | null
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          item_class?: string | null
          item_class_source?: string | null
          item_code: string
          item_type: string
          material_resolution_request_id?: string | null
          material_resolution_status?: string | null
          merged_at?: string | null
          merged_factor?: number | null
          merged_into_id?: string | null
          name: string
          normalized_key: string
          product_sku_id?: string | null
          source_hash?: string | null
          standard_unit_cost?: number
          trusted_source_batch_id?: string | null
          trusted_source_row_id?: string | null
          unit: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          canonical_material_id?: string | null
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          item_class?: string | null
          item_class_source?: string | null
          item_code?: string
          item_type?: string
          material_resolution_request_id?: string | null
          material_resolution_status?: string | null
          merged_at?: string | null
          merged_factor?: number | null
          merged_into_id?: string | null
          name?: string
          normalized_key?: string
          product_sku_id?: string | null
          source_hash?: string | null
          standard_unit_cost?: number
          trusted_source_batch_id?: string | null
          trusted_source_row_id?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "kitchen_inventory_items_canonical_material_id_fkey"
            columns: ["canonical_material_id"]
            isOneToOne: false
            referencedRelation: "sku_cogs_materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kitchen_inventory_items_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_catalog_jev_usage: {
        Row: {
          call_limit: number
          calls: number
          cost: number
          updated_at: string
          usage_date: string
        }
        Insert: {
          call_limit?: number
          calls?: number
          cost?: number
          updated_at?: string
          usage_date: string
        }
        Update: {
          call_limit?: number
          calls?: number
          cost?: number
          updated_at?: string
          usage_date?: string
        }
        Relationships: []
      }
      stock_catalog_suggestions: {
        Row: {
          cost: number | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          factor_source: string | null
          id: string
          item_id: string
          jev_answer: Json | null
          kind: string
          other_item_id: string | null
          probability: number
          prompt_version: string
          proposed_class: string | null
          proposed_factor: number | null
          proposed_target_id: string | null
          status: string
        }
        Insert: {
          cost?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          factor_source?: string | null
          id?: string
          item_id: string
          jev_answer?: Json | null
          kind: string
          other_item_id?: string | null
          probability: number
          prompt_version: string
          proposed_class?: string | null
          proposed_factor?: number | null
          proposed_target_id?: string | null
          status?: string
        }
        Update: {
          cost?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          factor_source?: string | null
          id?: string
          item_id?: string
          jev_answer?: Json | null
          kind?: string
          other_item_id?: string | null
          probability?: number
          prompt_version?: string
          proposed_class?: string | null
          proposed_factor?: number | null
          proposed_target_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_catalog_suggestions_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_catalog_suggestions_other_item_id_fkey"
            columns: ["other_item_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_catalog_suggestions_proposed_target_id_fkey"
            columns: ["proposed_target_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_item_merge_rows: {
        Row: {
          created_at: string
          id: string
          merge_id: string
          new_values: Json | null
          old_values: Json | null
          row_id: string
          table_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          merge_id: string
          new_values?: Json | null
          old_values?: Json | null
          row_id: string
          table_name: string
        }
        Update: {
          created_at?: string
          id?: string
          merge_id?: string
          new_values?: Json | null
          old_values?: Json | null
          row_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_item_merge_rows_merge_id_fkey"
            columns: ["merge_id"]
            isOneToOne: false
            referencedRelation: "stock_item_merges"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_item_merges: {
        Row: {
          applied_at: string
          applied_by: string | null
          factor: number
          id: string
          reverted_at: string | null
          reverted_by: string | null
          source_id: string
          status: string
          suggestion_id: string | null
          target_id: string
        }
        Insert: {
          applied_at?: string
          applied_by?: string | null
          factor: number
          id?: string
          reverted_at?: string | null
          reverted_by?: string | null
          source_id: string
          status?: string
          suggestion_id?: string | null
          target_id: string
        }
        Update: {
          applied_at?: string
          applied_by?: string | null
          factor?: number
          id?: string
          reverted_at?: string | null
          reverted_by?: string | null
          source_id?: string
          status?: string
          suggestion_id?: string | null
          target_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_item_merges_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_item_merges_suggestion_id_fkey"
            columns: ["suggestion_id"]
            isOneToOne: false
            referencedRelation: "stock_catalog_suggestions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_item_merges_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "kitchen_inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      cost_classification_category_summary: {
        Row: {
          allocation_rule: string | null
          category_code: string | null
          category_label: string | null
          cost_group: string | null
          first_source_date: string | null
          last_source_date: string | null
          line_count: number | null
          product_line: string | null
          review_status: string | null
          total_amount: number | null
        }
        Relationships: []
      }
      cost_classification_line_details: {
        Row: {
          allocation_rule: string | null
          category_code: string | null
          category_label: string | null
          classification_id: string | null
          classification_source: string | null
          confidence: number | null
          cost_group: string | null
          invoice_id: string | null
          line_amount: number | null
          payment_request_id: string | null
          payment_status: string | null
          product_code: string | null
          product_line: string | null
          product_name: string | null
          quantity: number | null
          revenue_channel: string | null
          review_status: string | null
          rule_id: string | null
          source_date: string | null
          source_line_id: string | null
          source_number: string | null
          source_status: string | null
          source_type: string | null
          supplier_id: string | null
          supplier_name: string | null
          unit: string | null
          unit_price: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      cost_classification_monthly_summary: {
        Row: {
          allocation_rule: string | null
          category_code: string | null
          category_label: string | null
          cost_group: string | null
          line_count: number | null
          month: string | null
          product_line: string | null
          review_status: string | null
          total_amount: number | null
        }
        Relationships: []
      }
      finance_reconciliation_flags: {
        Row: {
          amount: number | null
          category: string | null
          detected_at: string | null
          entity_id: string | null
          entity_ref: string | null
          entity_type: string | null
          evidence: Json | null
          flag_key: string | null
          group_key: string | null
          label: string | null
          priority: string | null
          review_note: string | null
          review_status: string | null
          supplier_id: string | null
          supplier_name: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      approve_payment_requests_with_unc: {
        Args: {
          p_evidence: Json
          p_idempotency_key: string
          p_request_ids: string[]
        }
        Returns: Json
      }
      claim_finance_zalo_notifications: {
        Args: { batch_size?: number }
        Returns: {
          attempts: number
          entity_id: string
          event_type: string
          group_key: string
          id: string
          message_body: string
        }[]
      }
      finance_unc_total_from_evidence: {
        Args: { p_date: string }
        Returns: Json
      }
      normalize_unc_reference: {
        Args: { p_reference: string }
        Returns: string
      }
      record_unc_without_request: {
        Args: { p_category: string; p_evidence: Json; p_note: string }
        Returns: Json
      }
      allow_purchase_order_overpay: {
        Args: {
          p_extra_amount: number
          p_purchase_order_id: string
          p_reason: string
        }
        Returns: {
          created_at: string
          created_by: string | null
          extra_amount: number
          id: string
          purchase_order_id: string
          reason: string
        }
      }
      review_finance_reconciliation_flag: {
        Args: {
          p_flag_key: string
          p_note: string | null
          p_status: string
        }
        Returns: {
          flag_key: string
          note: string | null
          reviewed_at: string
          reviewed_by: string | null
          status: string
        }
      }
      review_jev_duplicate_check: {
        Args: {
          p_decision: string
          p_note: string | null
          p_pair_key: string
        }
        Returns: {
          amount_newer: number | null
          amount_older: number | null
          checked_at: string
          days_apart: number | null
          id: string
          model: string | null
          p_same: number | null
          pair_key: string
          pr_newer: string
          pr_older: string
          prompt_version: string | null
          relation: string | null
          relation_confidence: number | null
          relation_prob: number | null
          review_decision: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          state_hash: string
          status: string
          supplier_id: string | null
        }
      }
      build_finance_zalo_cash_message: {
        Args: { p_event_type: string; p_request_id: string }
        Returns: string
      }
      can_edit_payment_request: {
        Args: { p_request_id: string }
        Returns: boolean
      }
      discard_cash_receipt: {
        Args: { p_receipt_id: string }
        Returns: Json
      }
      get_payment_request_unc_evidence: {
        Args: { p_request_id: string }
        Returns: Json
      }
      create_cash_payment_request: {
        Args: {
          p_idempotency_key: string
          p_payload: Json
        }
        Returns: Json
      }
      create_payment_submission: {
        Args: {
          p_idempotency_key: string
          p_note: string
          p_request_ids: string[]
        }
        Returns: Json
      }
      get_payment_submission: {
        Args: { p_id: string }
        Returns: Json
      }
      get_cash_settlement: {
        Args: { p_request_id: string }
        Returns: Json
      }
      submit_cash_settlement: {
        Args: {
          p_allocations: Json
          p_idempotency_key: string
          p_request_id: string
        }
        Returns: Json
      }
      ensure_purchase_order_receipt_queue: {
        Args: { p_purchase_order_id: string }
        Returns: string
      }
      generate_po_number: { Args: never; Returns: string }
      generate_receipt_number: { Args: never; Returns: string }
      generate_sku_code: {
        Args: {
          p_category: string
          p_product_name: string
          p_supplier_short_code: string
          p_unit: string
        }
        Returns: string
      }
      record_payment_allocations: {
        Args: {
          p_allocations: Json
          p_payment_method?:
            | Database["public"]["Enums"]["payment_method_type"]
            | null
          p_payment_date?: string | null
          p_reference_number?: string | null
          p_notes?: string | null
        }
        Returns: string
      }
      set_payment_request_requires_receipt: {
        Args: {
          p_request_id: string
          p_requires_receipt: boolean
          p_reason: string | null
        }
        Returns: Json
      }
      set_dealer_order_lock: {
        Args: {
          p_customer_id: string
          p_locked: boolean
          p_reason?: string | null
        }
        Returns: Json
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      cancel_salary_payout: {
        Args: { p_id: string }
        Returns: Json
      }
      create_salary_payout: {
        Args: { p_idempotency_key: string; p_period_id: string }
        Returns: Json
      }
      create_manual_salary_payout: {
        Args: { p_idempotency_key: string; p_payload: Json }
        Returns: Json
      }
      discard_salary_payout_receipt: {
        Args: { p_receipt_id: string }
        Returns: Json
      }
      get_salary_payout: {
        Args: { p_id: string }
        Returns: Json
      }
      record_salary_payout_ceo_payment: {
        Args: { p_evidence: Json; p_id: string; p_idempotency_key: string }
        Returns: Json
      }
      submit_salary_payout_matches: {
        Args: { p_id: string; p_idempotency_key: string; p_matches: Json }
        Returns: Json
      }
      get_stock_ledger_overview: {
        Args: { p_location: string; p_as_of?: string | null }
        Returns: Json
      }
      normalize_stock_item_name: {
        Args: { p_name: string }
        Returns: string
      }
      record_q7_stock_count: {
        Args: {
          p_kitchen_inventory_item_id: string
          p_counted_qty: number
          p_count_date: string
          p_note: string | null
          p_idempotency_key: string
        }
        Returns: Json
      }
      resolve_stock_alias: {
        Args: {
          p_goods_receipt_item_id: string
          p_location: string
          p_kitchen_inventory_item_id: string | null
          p_tan_tao_sku_id: string | null
          p_conversion_factor: number
          p_apply_to_supplier?: boolean
        }
        Returns: number
      }
      set_goods_receipt_receiving_location: {
        Args: {
          p_receipt_id: string
          p_location: string
          p_remember_for_supplier?: boolean
        }
        Returns: Json
      }
      set_supplier_receiving_location: {
        Args: { p_supplier_id: string; p_location: string | null }
        Returns: Json
      }
      get_q7_auto_purchase_status: {
        Args: never
        Returns: Json
      }
      get_q7_purchase_forecast: {
        Args: { p_as_of?: string | null; p_horizon_days?: number }
        Returns: Json
      }
      q7_purchase_daily_usage: {
        Args: { p_item: string; p_as_of: string }
        Returns: {
          avg_14d: number
          avg_28d: number
          days_with_data: number
          stddev_28d: number
          weekday_factor: number
        }[]
      }
      learn_q7_purchase_parameters: {
        Args: never
        Returns: Json
      }
      run_q7_auto_purchase: {
        Args: { p_run_date?: string | null }
        Returns: Json
      }
      run_q7_auto_purchase_now: {
        Args: never
        Returns: Json
      }
      upsert_q7_purchase_item_setting: {
        Args: {
          p_kitchen_inventory_item_id: string
          p_mode: string
          p_supplier_id?: string | null
          p_pack_size?: number | null
          p_pack_label?: string | null
          p_lead_time_days?: number | null
          p_safety_days?: number | null
          p_order_cycle_days?: number | null
          p_max_order_qty?: number | null
        }
        Returns: Json
      }
      update_q7_auto_purchase_settings: {
        Args: {
          p_enabled?: boolean | null
          p_system_actor_id?: string | null
          p_max_po_amount?: number | null
          p_max_daily_amount?: number | null
          p_max_stock_count_age_days?: number | null
          p_max_backtest_error?: number | null
          p_run_hour_vn?: number | null
        }
        Returns: Json
      }
      create_q7_draft_purchase_orders: {
        Args: { p_lines: Json; p_idempotency_key: string }
        Returns: Json
      }
      apply_stock_item_merge: {
        Args: {
          p_source: string
          p_target: string
          p_factor: number
          p_suggestion?: string | null
        }
        Returns: Json
      }
      decide_stock_catalog_suggestion: {
        Args: {
          p_id: string
          p_action: string
          p_factor?: number | null
          p_class?: string | null
        }
        Returns: Json
      }
      get_stock_catalog_candidates: {
        Args: never
        Returns: {
          left_id: string
          right_id: string
          left_name: string
          right_name: string
          left_unit: string
          right_unit: string
          left_item_type: string
          right_item_type: string
          left_issue_count_90d: number
          right_issue_count_90d: number
          left_movement_count_90d: number
          right_movement_count_90d: number
          left_canonical_material_id: string | null
          right_canonical_material_id: string | null
          left_canonical_material_code: string | null
          right_canonical_material_code: string | null
          left_to_right_factor: number | null
          right_to_left_factor: number | null
        }[]
      }
      get_stock_catalog_review: {
        Args: never
        Returns: Json
      }
      link_kitchen_items_to_canonical_materials: {
        Args: never
        Returns: Json
      }
      revert_stock_item_merge: {
        Args: { p_merge_id: string }
        Returns: Json
      }
      stock_item_merge_resolve: {
        Args: { p_item: string }
        Returns: {
          target_id: string
          factor: number
        }[]
      }
      stock_unit_factor: {
        Args: { p_from: string; p_to: string }
        Returns: number | null
      }
      material_alias_can_view: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      material_alias_can_edit: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      material_alias_can_admin: {
        Args: { p_actor_id: string }
        Returns: boolean
      }
      material_alias_candidate_score: {
        Args: { p_raw: string; p_candidate: string }
        Returns: number
      }
      material_alias_candidates_hash: {
        Args: { p_candidate_ids: string[] }
        Returns: string
      }
      material_alias_candidates: {
        Args: { p_name: string; p_location: string; p_limit?: number }
        Returns: {
          item_id: string | null
          sku_id: string | null
          name: string
          unit: string
          score: number
          reason: string
        }[]
      }
      stock_line_auto_non_stock: {
        Args: { p_name: string }
        Returns: string
      }
      suggest_material_aliases: {
        Args: { p_supplier_id: string | null; p_location: string; p_lines: Json }
        Returns: Json
      }
      confirm_material_alias: {
        Args: {
          p_supplier_id: string | null
          p_location: string
          p_raw_name: string
          p_raw_unit: string | null
          p_kitchen_inventory_item_id: string | null
          p_tan_tao_sku_id: string | null
          p_entered_unit_label: string | null
          p_conversion_factor: number
          p_jev_item_id: string | null
          p_jev_probability: number | null
          p_source_table: string | null
          p_source_id: string | null
          p_line_class?: string
        }
        Returns: Json
      }
      undo_material_alias_event: {
        Args: { p_event_id: string }
        Returns: Json
      }
      set_material_alias_status: {
        Args: { p_alias_id: string; p_status: string }
        Returns: Json
      }
      get_material_alias_review: {
        Args: { p_days?: number }
        Returns: Json
      }
      get_stock_routing_review: {
        Args: never
        Returns: Json
      }
      decide_supplier_routing: {
        Args: { p_id: string; p_action: string; p_location?: string | null }
        Returns: Json
      }
      revert_supplier_routing: {
        Args: { p_suggestion: string }
        Returns: Json
      }
      decide_material_category: {
        Args: { p_id: string; p_action: string; p_category?: string | null }
        Returns: Json
      }
      revert_material_category: {
        Args: { p_suggestion: string }
        Returns: Json
      }
      get_material_alias_backlog: {
        Args: { p_location?: string; p_limit?: number }
        Returns: {
          supplier_id: string | null
          normalized_name: string
          raw_name: string
          raw_unit: string | null
          location: string
          receipt_count: number
        }[]
      }
    }
    Enums: {
      app_role: "owner" | "staff" | "viewer" | "warehouse"
      delivery_status: "pending" | "delivered"
      goods_receipt_status: "draft" | "confirmed" | "received"
      sku_type: "raw_material" | "finished_good"
      payment_method_type: "bank_transfer" | "cash"
      payment_request_status: "pending" | "approved" | "rejected"
      payment_status: "unpaid" | "partial" | "paid" | "overpaid"
      payment_type: "old_order" | "new_order"
      purchase_order_status:
        | "draft"
        | "sent"
        | "in_transit"
        | "completed"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "staff", "viewer", "warehouse"],
      delivery_status: ["pending", "delivered"],
      goods_receipt_status: ["draft", "confirmed", "received"],
      sku_type: ["raw_material", "finished_good"],
      payment_method_type: ["bank_transfer", "cash"],
      payment_request_status: ["pending", "approved", "rejected"],
      payment_status: ["unpaid", "partial", "paid", "overpaid"],
      payment_type: ["old_order", "new_order"],
      purchase_order_status: [
        "draft",
        "sent",
        "in_transit",
        "completed",
        "cancelled",
      ],
    },
  },
} as const
