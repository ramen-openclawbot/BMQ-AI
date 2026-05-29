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
    }
    Functions: {
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
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
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
