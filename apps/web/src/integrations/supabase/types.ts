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
          created_at: string
          expiry_date: string | null
          goods_receipt_id: string
          id: string
          inventory_item_id: string | null
          manufacture_date: string | null
          notes: string | null
          product_name: string
          quantity: number
          sku_id: string | null
          unit: string | null
        }
        Insert: {
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id: string
          id?: string
          inventory_item_id?: string | null
          manufacture_date?: string | null
          notes?: string | null
          product_name: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
        }
        Update: {
          created_at?: string
          expiry_date?: string | null
          goods_receipt_id?: string
          id?: string
          inventory_item_id?: string | null
          manufacture_date?: string | null
          notes?: string | null
          product_name?: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
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
          id: string
          image_url: string | null
          notes: string | null
          payment_request_id: string | null
          product_photos: string[] | null
          purchase_order_id: string | null
          receipt_date: string
          receipt_number: string
          status: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id: string | null
          total_quantity: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          payment_request_id?: string | null
          product_photos?: string[] | null
          purchase_order_id?: string | null
          receipt_date?: string
          receipt_number: string
          status?: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id?: string | null
          total_quantity?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          notes?: string | null
          payment_request_id?: string | null
          product_photos?: string[] | null
          purchase_order_id?: string | null
          receipt_date?: string
          receipt_number?: string
          status?: Database["public"]["Enums"]["goods_receipt_status"]
          supplier_id?: string | null
          total_quantity?: number | null
          updated_at?: string
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
          created_at: string
          id: string
          inventory_item_id: string | null
          invoice_id: string
          line_total: number | null
          notes: string | null
          product_code: string | null
          product_name: string
          quantity: number
          unit: string | null
          unit_price: number
        }
        Insert: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          invoice_id: string
          line_total?: number | null
          notes?: string | null
          product_code?: string | null
          product_name: string
          quantity?: number
          unit?: string | null
          unit_price?: number
        }
        Update: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          invoice_id?: string
          line_total?: number | null
          notes?: string | null
          product_code?: string | null
          product_name?: string
          quantity?: number
          unit?: string | null
          unit_price?: number
        }
        Relationships: [
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
          subtotal?: number | null
          supplier_id?: string | null
          total_amount?: number | null
          updated_at?: string
          vat_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
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
      payment_request_items: {
        Row: {
          created_at: string
          id: string
          inventory_item_id: string | null
          last_price: number | null
          line_total: number | null
          notes: string | null
          payment_request_id: string
          price_change_percent: number | null
          product_code: string | null
          product_name: string
          quantity: number
          sku_id: string | null
          unit: string | null
          unit_price: number
        }
        Insert: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          last_price?: number | null
          line_total?: number | null
          notes?: string | null
          payment_request_id: string
          price_change_percent?: number | null
          product_code?: string | null
          product_name: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number
        }
        Update: {
          created_at?: string
          id?: string
          inventory_item_id?: string | null
          last_price?: number | null
          line_total?: number | null
          notes?: string | null
          payment_request_id?: string
          price_change_percent?: number | null
          product_code?: string | null
          product_name?: string
          quantity?: number
          sku_id?: string | null
          unit?: string | null
          unit_price?: number
        }
        Relationships: [
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
      product_skus: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          id: string
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
          created_at?: string
          created_by?: string | null
          id?: string
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
          created_at?: string
          created_by?: string | null
          id?: string
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
      [_ in never]: never
    }
    Functions: {
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
      payment_method_type: "bank_transfer" | "cash"
      payment_request_status: "pending" | "approved" | "rejected"
      payment_status: "unpaid" | "paid"
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
      payment_method_type: ["bank_transfer", "cash"],
      payment_request_status: ["pending", "approved", "rejected"],
      payment_status: ["unpaid", "paid"],
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
