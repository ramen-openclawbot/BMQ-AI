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
          description: string | null
          email: string | null
          id: string
          name: string
          payment_terms_days: number | null
          phone: string | null
          short_code: string | null
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
          description?: string | null
          email?: string | null
          id?: string
          name: string
          payment_terms_days?: number | null
          phone?: string | null
          short_code?: string | null
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
          description?: string | null
          email?: string | null
          id?: string
          name?: string
          payment_terms_days?: number | null
          phone?: string | null
          short_code?: string | null
          updated_at?: string
          vat_included_in_price?: boolean | null
        }
        Relationships: []
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
          payroll_period_id: string
          payout_number: string
          period_name: string
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
          payroll_period_id: string
          payout_number: string
          period_name: string
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
          payroll_period_id?: string
          payout_number?: string
          period_name?: string
          status?: string
          total_amount?: number
        }
        Relationships: []
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
